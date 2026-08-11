import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FABRIC_LIMITS } from "./constants";
import type { FabricHarnessProducerKind, FabricPatchExecutorInput, SyntheticPatchV1 } from "./types";
import { FabricTaskError } from "./types";

const CHILD_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "producer-child.ts");

interface IsolateRequest {
  harnessKind?: FabricHarnessProducerKind;
  executorModulePath?: string;
  scratchRoot: string;
  totalTimeoutMs: number;
  inactivityTimeoutMs: number;
  executorInput?: FabricPatchExecutorInput;
}

interface IsolateResponse {
  ok: boolean;
  patch?: SyntheticPatchV1;
  error?: { message: string; code: string; attribution: string };
}

function minimalChildEnv(): Record<string, string> {
  return { TZ: "UTC", NO_COLOR: "1" };
}

/** Run a fabric patch producer in an isolated child process with hard termination. */
export async function runIsolatedFabricProducer(request: IsolateRequest): Promise<SyntheticPatchV1> {
  return await new Promise<SyntheticPatchV1>((resolve, reject) => {
    const child = spawn(process.execPath, ["run", CHILD_ENTRY], {
      env: minimalChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      fn();
    };

    const totalTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(() => reject(new FabricTaskError("total timeout exceeded", "timeout", "environment")));
    }, request.totalTimeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", () => {
      /* discard */
    });

    child.on("error", (error) => {
      finish(() => reject(new FabricTaskError(error.message, "harness_failure", "harness")));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal === "SIGKILL") {
        finish(() => reject(new FabricTaskError("total timeout exceeded", "timeout", "environment")));
        return;
      }
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          finish(() => reject(new FabricTaskError("isolated producer returned no output", "harness_failure", "harness")));
          return;
        }
        const parsed = JSON.parse(trimmed) as IsolateResponse;
        if (!parsed.ok || !parsed.patch) {
          const code = parsed.error?.code ?? "harness_failure";
          const attribution = parsed.error?.attribution === "environment" ? "environment" : "harness";
          const fabricCode = code === "inactivity_timeout"
            ? "inactivity_timeout"
            : code === "timeout"
              ? "timeout"
              : code === "sandbox_violation"
                ? "sandbox_violation"
                : "harness_failure";
          finish(() => reject(new FabricTaskError(parsed.error?.message ?? "isolated producer failed", fabricCode, attribution)));
          return;
        }
        finish(() => resolve(parsed.patch!));
      } catch (error) {
        finish(() => reject(new FabricTaskError(
          error instanceof Error ? error.message : String(error),
          "harness_failure",
          "harness",
        )));
      }
      void code;
    });

    const payload = JSON.stringify({
      harnessKind: request.harnessKind,
      executorModulePath: request.executorModulePath,
      scratchRoot: request.scratchRoot,
      totalTimeoutMs: request.totalTimeoutMs,
      inactivityTimeoutMs: request.inactivityTimeoutMs,
      executorInput: request.executorInput
        ? {
            routeContext: request.executorInput.routeContext,
            destination: request.executorInput.destination,
            routeSubject: request.executorInput.routeSubject,
            scratchRoot: request.executorInput.scratchRoot,
          }
        : undefined,
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** Default isolation limits for fabric producer child processes. */
export function fabricProducerIsolationLimits(): { totalTimeoutMs: number; inactivityTimeoutMs: number } {
  return {
    totalTimeoutMs: FABRIC_LIMITS.totalTimeoutMs,
    inactivityTimeoutMs: FABRIC_LIMITS.inactivityTimeoutMs,
  };
}
