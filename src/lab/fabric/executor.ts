import type { FailureRecordV1, RouteSubjectV1 } from "../events/types";
import { labSandboxEnvironment, rejectProxyEnvironment } from "../live/sandbox";
import {
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_LIMITS,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import { applySyntheticPatch, parseSyntheticPatchV1 } from "./patch";
import { assertNotUnderUserRepo, createSyntheticScratch } from "./scratch";
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

function failureFromError(error: FabricTaskError): FailureRecordV1 {
  return {
    class: error.code,
    code: error.code,
    retryable: error.code === "timeout" || error.code === "inactivity_timeout" || error.code === "budget_exhausted",
    attribution: error.attribution,
  };
}

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
    inputBytes: Buffer.byteLength("before\n", "utf8"),
    outputBytes: 0,
    patchOperations: 0,
    filesTouched: 0,
    artifactBytes: 0,
    elapsedMs: 0,
    inactiveMs: 0,
  };

  const scratch = createSyntheticScratch(options.configDir);
  try {
    if (options.userRepoRoot) {
      assertNotUnderUserRepo(scratch.root, options.userRepoRoot);
    }

    const deadline = startedAt + FABRIC_LIMITS.totalTimeoutMs;
    const produceStarted = options.now?.() ?? Date.now();
    let patchRaw: unknown;
    try {
      const producePromise = Promise.resolve(options.producePatch({
        taskClassId: FABRIC_TASK_CLASS_ID,
        taskClassVersion: FABRIC_TASK_CLASS_VERSION,
        scratchRoot: scratch.root,
      }));
      patchRaw = await withTimeout(producePromise, FABRIC_LIMITS.totalTimeoutMs, FABRIC_LIMITS.inactivityTimeoutMs, options);
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
            verifierId: "exact-tree-diff-v1",
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
          verifierId: "exact-tree-diff-v1",
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
        verifierId: "exact-tree-diff-v1",
        manifestDigest: verifierDigest,
        passed: false,
        pathSummaries: [],
        reason: "harness_failure",
      },
      failure,
      sourceRefs: options.sourceRefs,
    });
  } finally {
    scratch.cleanup();
  }
}

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

async function withTimeout<T>(
  promise: Promise<T>,
  totalMs: number,
  inactivityMs: number,
  options: RunFabricTaskOptions,
): Promise<T> {
  let settled = false;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return await new Promise<T>((resolve, reject) => {
    const totalTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new FabricTaskError("total timeout exceeded", "timeout", "environment"));
      }
    }, totalMs);
    const inactivityTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new FabricTaskError("inactivity timeout exceeded", "inactivity_timeout", "environment"));
      }
    }, inactivityMs);
    void sleep(0);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(inactivityTimer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(inactivityTimer);
        reject(error);
      },
    );
  });
}

/** Explicit denials for capabilities that must remain unavailable in the scratch producer. */
export function fabricScratchCapabilityProbe(): {
  network: false;
  userMcp: false;
  arbitraryShell: false;
  userRepository: false;
} {
  return {
    network: false,
    userMcp: false,
    arbitraryShell: false,
    userRepository: false,
  };
}
