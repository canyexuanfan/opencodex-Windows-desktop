import {
  FABRIC_LIMITS,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import type { FabricHarnessProducerKind, SyntheticPatchV1 } from "./types";

interface ChildRequest {
  harnessKind?: FabricHarnessProducerKind;
  executorModulePath?: string;
  scratchRoot: string;
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  executorInput?: unknown;
}

interface ChildResponse {
  ok: boolean;
  patch?: SyntheticPatchV1;
  error?: { message: string; code: string; attribution: string };
}

function correctPatch(): SyntheticPatchV1 {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}

function wrongPatch(): SyntheticPatchV1 {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: "wrong\n" }],
  };
}

async function runHarness(kind: FabricHarnessProducerKind, scratchRoot: string): Promise<SyntheticPatchV1> {
  switch (kind) {
    case "deterministic_correct":
      return correctPatch();
    case "deterministic_wrong":
      return wrongPatch();
    case "infinite_sync":
      while (true) {
        /* hang until killed */
      }
    case "never_resolve":
      await new Promise<SyntheticPatchV1>(() => undefined);
      throw new Error("never_resolve unexpectedly completed");
    case "mutate_after_delay":
      await Bun.sleep(FABRIC_LIMITS.totalTimeoutMs + 5_000);
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      mkdirSync(join(scratchRoot, dirname(SYNTHETIC_VALUE_PATH)), { recursive: true });
      writeFileSync(join(scratchRoot, SYNTHETIC_VALUE_PATH), "late\n");
      return correctPatch();
    default:
      throw new Error(`unsupported harness kind: ${kind as string}`);
  }
}

async function runExecutorModule(
  modulePath: string,
  executorInput: unknown,
  inactivityTimeoutMs: number,
): Promise<SyntheticPatchV1> {
  const mod = await import(modulePath) as { execute: (input: unknown) => Promise<SyntheticPatchV1> | SyntheticPatchV1 };
  if (typeof mod.execute !== "function") throw new Error("executor module missing execute export");
  let lastActivity = Date.now();
  const input = {
    ...(executorInput as Record<string, unknown>),
    reportActivity: () => {
      lastActivity = Date.now();
    },
  };
  const inactivity = setInterval(() => {
    if (Date.now() - lastActivity > inactivityTimeoutMs) {
      throw new Error("inactivity_timeout");
    }
  }, 50);
  try {
    return await Promise.resolve(mod.execute(input));
  } finally {
    clearInterval(inactivity);
  }
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const req = JSON.parse(raw) as ChildRequest;
  let patch: SyntheticPatchV1;
  if (req.harnessKind) {
    patch = await runHarness(req.harnessKind, req.scratchRoot);
  } else if (req.executorModulePath) {
    patch = await runExecutorModule(req.executorModulePath, req.executorInput, req.inactivityTimeoutMs);
  } else {
    throw new Error("child request missing harnessKind or executorModulePath");
  }
  const response: ChildResponse = { ok: true, patch };
  process.stdout.write(JSON.stringify(response));
}

main().catch((error: unknown) => {
  const response: ChildResponse = {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof Error && error.message === "inactivity_timeout" ? "inactivity_timeout" : "harness_failure",
      attribution: "harness",
    },
  };
  process.stdout.write(JSON.stringify(response));
  process.exit(1);
});
