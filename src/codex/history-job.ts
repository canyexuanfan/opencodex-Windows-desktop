/**
 * The parent half of the history unit: derive the operation, dispatch the
 * Worker, and never let its failure become the caller's stall.
 *
 * The operation is DERIVED here from what the caller already decided — its
 * config and the direction its native mutation just took — and then handed down
 * as a fixed value. It is not a request field the Worker trusts, because the
 * distinctions are real: `syncResumeHistory: false` means leave history alone,
 * apply targets opencodex only in legacy mode, and legacy recovery must not
 * touch the manifest that generic restore consumes.
 *
 * Every exit is typed. A Worker that errors, dies, or overruns its watchdog
 * produces an outcome the caller can record, because the alternative — an
 * exception crossing back into a route that already persisted its mutation — is
 * how a successful change gets reported as a 500.
 *
 * Design record: devlog/_plan/260804_codex_write_substrate/020_history_isolation.md.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  CodexHistoryWorkerOperation,
  HistoryWorkerResult,
} from "./history-worker";
import { historyBackupPathFor } from "./history-provider";
import { getCodexHome } from "./paths";

/** Where Codex keeps its resume history, and the manifest that shadows it. */
const STATE_DB_FILE = "state_5.sqlite";

/**
 * Resolve the paths a history job needs, at CALL time.
 *
 * `history-provider.ts` resolves its equivalents at module load (`:16`, `:22`),
 * which is fine in one process and wrong for a Worker: the Worker does not
 * inherit them, so anything derived from those constants would address a
 * different home than the caller intended. Resolving here also means a test that
 * moves `CODEX_HOME` is honoured rather than ignored.
 */
export function resolveCodexHistoryJobTarget(): {
  readonly canonicalCodexHome: string;
  readonly canonicalStateDbPath: string;
  readonly canonicalBackupPath: string;
} {
  const home = getCodexHome();
  const stateDb = join(home, STATE_DB_FILE);
  return {
    canonicalCodexHome: home,
    canonicalStateDbPath: stateDb,
    // Derived by the provider's own rule rather than guessed: the manifest lives
    // in the config directory under a hash of the state database, so a
    // hand-built path would address a different file entirely.
    canonicalBackupPath: historyBackupPathFor(stateDb),
  };
}

/** How long a history unit may run before the parent stops waiting on it. */
const WORKER_TIMEOUT_MS = 30_000;

export interface CodexHistoryJobRequest {
  readonly canonicalCodexHome: string;
  readonly canonicalStateDbPath: string;
  readonly canonicalBackupPath: string;
  readonly operation: CodexHistoryWorkerOperation;
}

export type CodexHistoryJobOutcome =
  | { readonly kind: "converged"; readonly rows: number; readonly files: number }
  | { readonly kind: "skipped" }
  | { readonly kind: "blocked"; readonly reason: "busy" | "database" | "unsafe-path" }
  | { readonly kind: "failed"; readonly reason: "worker-error" | "worker-died" | "timeout";
      readonly message: string };

/**
 * Derive the durable history operation from admitted intent.
 *
 * `resumeHistory === false` is the user's explicit opt-out and outranks the
 * direction entirely — an apply that quietly migrated history anyway would be
 * the setting failing silently. `legacyMode` is the only case that routes
 * history TO opencodex; the ordinary apply migrates to native so a later restore
 * has nothing to undo.
 */
export function deriveCodexHistoryOperation(intent: {
  readonly direction: "apply" | "restore";
  readonly resumeHistory: boolean;
  readonly legacyMode: boolean;
}): CodexHistoryWorkerOperation {
  if (!intent.resumeHistory) return "skip";
  if (intent.direction === "restore") return "restore-openai";
  return intent.legacyMode ? "apply-opencodex" : "migrate-openai";
}

function classifyWorkerResult(result: HistoryWorkerResult): CodexHistoryJobOutcome {
  if (result.type === "blocked") return { kind: "blocked", reason: result.reason };
  if (result.type === "error") {
    return { kind: "failed", reason: "worker-error", message: result.message };
  }
  return result.outcome === "skipped"
    ? { kind: "skipped" }
    : { kind: "converged", rows: result.rows, files: result.files };
}

/**
 * Run one history unit in a Worker and join it before returning.
 *
 * The join is not optional politeness: returning while the thread may still be
 * mutating CODEX_HOME would let a caller's next step observe a half-applied
 * transition, and would let a test suite reach its next file with a worker still
 * exiting behind it.
 */
export async function runCodexHistoryJob(
  request: CodexHistoryJobRequest,
  options: { readonly timeoutMs?: number } = {},
): Promise<CodexHistoryJobOutcome> {
  const requestId = randomUUID();
  const jobId = randomUUID();
  const timeoutMs = options.timeoutMs ?? WORKER_TIMEOUT_MS;

  // `skip` writes nothing, so spawning a thread to decide that would be pure
  // cost. It still returns a recorded outcome rather than silence.
  if (request.operation === "skip") return { kind: "skipped" };

  let worker: Worker;
  try {
    worker = new Worker(new URL("./history-worker.ts", import.meta.url).href);
  } catch (error) {
    return {
      kind: "failed",
      reason: "worker-died",
      message: error instanceof Error ? error.message : "history_worker_spawn_failed",
    };
  }

  return new Promise<CodexHistoryJobOutcome>(resolve => {
    let settled = false;
    const finish = (outcome: CodexHistoryJobOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminate and join before settling: see the note above.
      const done = () => resolve(outcome);
      try {
        const terminated = worker.terminate() as unknown;
        if (terminated && typeof (terminated as Promise<unknown>).then === "function") {
          void (terminated as Promise<unknown>).then(done, done);
          return;
        }
      } catch { /* already gone */ }
      done();
    };

    const timer = setTimeout(() => {
      finish({ kind: "failed", reason: "timeout", message: "history_worker_timeout" });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const message = data as Record<string, unknown>;
      // A reply for a different request is somebody else's; ignoring it is not
      // the same as accepting it.
      if (message.requestId !== requestId) return;
      if (message.type !== "done" && message.type !== "blocked" && message.type !== "error") {
        return;
      }
      finish(classifyWorkerResult(message as unknown as HistoryWorkerResult));
    };

    worker.onerror = (event: ErrorEvent) => {
      finish({
        kind: "failed",
        reason: "worker-died",
        message: event.message || "history_worker_failed",
      });
    };

    worker.postMessage({
      type: "run",
      requestId,
      jobId,
      operation: request.operation,
      canonicalCodexHome: request.canonicalCodexHome,
      canonicalStateDbPath: request.canonicalStateDbPath,
      canonicalBackupPath: request.canonicalBackupPath,
      env: {
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        ...(process.env.OPENCODEX_HOME ? { OPENCODEX_HOME: process.env.OPENCODEX_HOME } : {}),
      },
    });
  });
}
