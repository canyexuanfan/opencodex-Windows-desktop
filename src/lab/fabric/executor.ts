import type { FailureRecordV1, RouteSubjectV1 } from "../events/types";
import { labSandboxEnvironment, rejectProxyEnvironment } from "../live/sandbox";
import {
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_LIMITS,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
  FABRIC_VERIFIER_ID,
  SANDBOX_PROFILE_V1,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import { applySyntheticPatch, parseSyntheticPatchV1 } from "./patch";
import { assertNotUnderUserRepo, createSyntheticScratch, type ScratchTree } from "./scratch";
import {
  buildTaskSubjectV1,
  sandboxProfileDigest,
  taskFixtureDigest,
  taskSubjectId,
  verifierManifestDigest,
} from "./subject";
import type {
  FabricTaskOutcomeV1,
  FabricUsageV1,
  SyntheticPatchProducer,
  SyntheticPatchV1,
} from "./types";
import { FabricTaskError } from "./types";
import { verifyExactTreeDiffV1 } from "./verifier";

/** Options for running the bounded synthetic-patch fabric task executor. */
export interface RunFabricTaskOptions {
  routeSubject: RouteSubjectV1;
  producePatch: SyntheticPatchProducer;
  configDir?: string;
  /** Optional absolute user repo path used only for containment proofs in tests. */
  userRepoRoot?: string;
  sourceRefs?: string[];
  now?: () => number;
  /** Override clocks for inactivity/timeout tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Map a FabricTaskError into a ledger failure record. */
function failureFromError(error: FabricTaskError): FailureRecordV1 {
  return {
    class: error.code,
    code: error.code,
    retryable: error.code === "timeout" || error.code === "inactivity_timeout" || error.code === "budget_exhausted",
    attribution: error.attribution,
  };
}

/** Map a failure record to the observation outcome kind for persistence. */
function outcomeFromFailure(failure: FailureRecordV1): FabricTaskOutcomeV1["outcome"] {
  if (failure.class === "behavioral_failure") return "fail";
  if (failure.attribution === "harness") return "inconclusive";
  return "blocked";
}

/** Closed successful patch for deterministic harness injection. */
export function correctSyntheticPatch(): SyntheticPatchV1 {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}

/**
 * Bounded Lab-owned fabric task executor for fabric-core.task.synthetic-patch@1.0.0.
 * Does not provide a general Agent Fabric platform.
 */
export async function runFabricSyntheticPatchTask(options: RunFabricTaskOptions): Promise<FabricTaskOutcomeV1> {
  rejectProxyEnvironment();
  labSandboxEnvironment();

  const startedAt = options.now?.() ?? Date.now();
  const fixtureDigest = taskFixtureDigest();
  const verifierDigest = verifierManifestDigest();
  const sandboxDigest = sandboxProfileDigest();
  const taskSubject = buildTaskSubjectV1({
    routeSubject: options.routeSubject,
    taskFixtureDigest: fixtureDigest,
    verifierManifestDigest: verifierDigest,
    sandboxProfileDigest: sandboxDigest,
    fabricCompatibilityVersion: FABRIC_COMPATIBILITY_VERSION,
  });
  const subjectId = taskSubjectId(taskSubject);

  const usage: FabricUsageV1 = {
    inputBytes: Buffer.byteLength(SYNTHETIC_BEFORE_UTF8, "utf8"),
    outputBytes: 0,
    patchOperations: 0,
    filesTouched: 0,
    artifactBytes: 0,
    elapsedMs: 0,
    inactiveMs: 0,
  };

  let scratch: ScratchTree | undefined;
  try {
    scratch = createSyntheticScratch(options.configDir);
    if (options.userRepoRoot) {
      assertNotUnderUserRepo(scratch.root, options.userRepoRoot);
    }

    const deadline = startedAt + FABRIC_LIMITS.totalTimeoutMs;
    const produceStarted = options.now?.() ?? Date.now();
    let patchRaw: unknown;
    try {
      const controller = createTimeoutController(FABRIC_LIMITS.totalTimeoutMs, FABRIC_LIMITS.inactivityTimeoutMs, options);
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      patchRaw = await controller.race(
        sleep(0).then(() => options.producePatch({
          taskClassId: FABRIC_TASK_CLASS_ID,
          taskClassVersion: FABRIC_TASK_CLASS_VERSION,
          scratchRoot: scratch!.root,
          reportActivity: controller.reportActivity,
        })),
      );
    } catch (error) {
      const completedAt = options.now?.() ?? Date.now();
      usage.elapsedMs = completedAt - startedAt;
      usage.inactiveMs = Math.max(0, completedAt - produceStarted);
      if (error instanceof FabricTaskError) {
        const failure = failureFromError(error);
        return sealOutcome({
          taskSubject,
          subjectId,
          fixtureDigest,
          verifierDigest,
          sandboxDigest,
          startedAt,
          completedAt,
          usage,
          outcome: outcomeFromFailure(failure),
          verifier: {
            verifierId: FABRIC_VERIFIER_ID,
            manifestDigest: verifierDigest,
            passed: false,
            pathSummaries: [],
            reason: error.code,
          },
          failure,
          sourceRefs: options.sourceRefs,
        });
      }
      throw error;
    }

    if ((options.now?.() ?? Date.now()) > deadline) {
      throw new FabricTaskError("total timeout exceeded", "timeout", "environment");
    }

    const patch = parseSyntheticPatchV1(patchRaw);
    const applied = applySyntheticPatch(scratch.root, patch);
    usage.outputBytes = applied.bytesWritten;
    usage.patchOperations = applied.patchOperations;
    usage.filesTouched = applied.filesTouched;

    const verifier = verifyExactTreeDiffV1(scratch.root);
    const completedAt = options.now?.() ?? Date.now();
    usage.elapsedMs = completedAt - startedAt;

    if (verifier.passed) {
      return sealOutcome({
        taskSubject,
        subjectId,
        fixtureDigest,
        verifierDigest,
        sandboxDigest,
        startedAt,
        completedAt,
        usage,
        outcome: "pass",
        verifier,
        sourceRefs: options.sourceRefs,
      });
    }

    const failure: FailureRecordV1 = {
      class: "behavioral_failure",
      code: verifier.reason ?? "verifier_failed",
      retryable: false,
      attribution: "route",
    };
    return sealOutcome({
      taskSubject,
      subjectId,
      fixtureDigest,
      verifierDigest,
      sandboxDigest,
      startedAt,
      completedAt,
      usage,
      outcome: "fail",
      verifier,
      failure,
      sourceRefs: options.sourceRefs,
    });
  } catch (error) {
    const completedAt = options.now?.() ?? Date.now();
    usage.elapsedMs = completedAt - startedAt;
    if (error instanceof FabricTaskError) {
      const failure = failureFromError(error);
      return sealOutcome({
        taskSubject,
        subjectId,
        fixtureDigest,
        verifierDigest,
        sandboxDigest,
        startedAt,
        completedAt,
        usage,
        outcome: outcomeFromFailure(failure),
        verifier: {
          verifierId: FABRIC_VERIFIER_ID,
          manifestDigest: verifierDigest,
          passed: false,
          pathSummaries: [],
          reason: error.code,
        },
        failure,
        sourceRefs: options.sourceRefs,
      });
    }
    const failure: FailureRecordV1 = {
      class: "harness_failure",
      code: "harness_failure",
      retryable: false,
      attribution: "harness",
    };
    return sealOutcome({
      taskSubject,
      subjectId,
      fixtureDigest,
      verifierDigest,
      sandboxDigest,
      startedAt,
      completedAt,
      usage,
      outcome: "inconclusive",
      verifier: {
        verifierId: FABRIC_VERIFIER_ID,
        manifestDigest: verifierDigest,
        passed: false,
        pathSummaries: [],
        reason: "harness_failure",
      },
      failure,
      sourceRefs: options.sourceRefs,
    });
  } finally {
    scratch?.cleanup();
  }
}

/** Assemble an immutable FabricTaskOutcomeV1 from executor state. */
function sealOutcome(input: {
  taskSubject: FabricTaskOutcomeV1["taskSubject"];
  subjectId: string;
  fixtureDigest: string;
  verifierDigest: string;
  sandboxDigest: string;
  startedAt: number;
  completedAt: number;
  usage: FabricUsageV1;
  outcome: FabricTaskOutcomeV1["outcome"];
  verifier: FabricTaskOutcomeV1["verifier"];
  failure?: FailureRecordV1;
  sourceRefs?: string[];
}): FabricTaskOutcomeV1 {
  const sealed: FabricTaskOutcomeV1 = {
    schemaVersion: 1,
    taskClassId: FABRIC_TASK_CLASS_ID,
    taskClassVersion: FABRIC_TASK_CLASS_VERSION,
    routeSubject: input.taskSubject.routeSubject,
    taskSubject: input.taskSubject,
    subjectId: input.subjectId,
    taskFixtureDigest: input.fixtureDigest,
    verifierManifestDigest: input.verifierDigest,
    fabricCompatibilityVersion: FABRIC_COMPATIBILITY_VERSION,
    sandboxProfileDigest: input.sandboxDigest,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    limits: { ...FABRIC_LIMITS },
    usage: { ...input.usage },
    outcome: input.outcome,
    verifier: {
      ...input.verifier,
      pathSummaries: [...input.verifier.pathSummaries],
    },
    ...(input.failure ? { failure: { ...input.failure } } : {}),
    artifactDigests: [],
    ...(input.sourceRefs ? { sourceRefs: [...input.sourceRefs] } : {}),
  };
  return sealed;
}

/** Arm total and inactivity deadlines around producer execution. */
function createTimeoutController(
  totalMs: number,
  inactivityMs: number,
  options: RunFabricTaskOptions,
): {
  reportActivity: () => void;
  race: <T>(promise: Promise<T>) => Promise<T>;
} {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let settled = false;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectRef: ((error: FabricTaskError) => void) | undefined;

  const clearTimers = () => {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    totalTimer = undefined;
    inactivityTimer = undefined;
  };

  const settleReject = (error: FabricTaskError) => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectRef?.(error);
  };

  const armInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      settleReject(new FabricTaskError("inactivity timeout exceeded", "inactivity_timeout", "environment"));
    }, inactivityMs);
  };

  return {
    reportActivity: () => {
      if (settled) return;
      armInactivity();
    },
    race: async <T>(promise: Promise<T>): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        rejectRef = reject;
        totalTimer = setTimeout(() => {
          settleReject(new FabricTaskError("total timeout exceeded", "timeout", "environment"));
        }, totalMs);
        armInactivity();
        // Keep the injected sleep seam observable for tests without discarding work.
        void sleep(0).catch(() => undefined);
        promise.then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimers();
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimers();
            reject(error);
          },
        );
      });
    },
  };
}

/** Declared sandbox policy for the frozen scratch producer (not runtime enforcement). */
export function fabricDeclaredSandboxPolicy(): {
  network: boolean;
  userMcp: boolean;
  arbitraryShell: boolean;
  userRepository: boolean;
} {
  return {
    network: SANDBOX_PROFILE_V1.allowNetwork,
    userMcp: SANDBOX_PROFILE_V1.allowUserMcp,
    arbitraryShell: SANDBOX_PROFILE_V1.allowShell,
    userRepository: SANDBOX_PROFILE_V1.allowUserRepository,
  };
}

/** @deprecated Use fabricDeclaredSandboxPolicy. */
export const fabricScratchCapabilityProbe = fabricDeclaredSandboxPolicy;
