# 055 — Cursor background-shell lifecycle

Date: 2026-08-01  
Work phase: wp6b  
Depends on: none; parallel-safe with 040/050  
Binding inputs: inventory store 30, `005_impl_roadmap.md` phase 055 and regression classes.

## Outcome

Keep Cursor native local execution disabled by default. When a trusted operator opts into
`nativeLocalExec: "on"`, every background shell belongs to one transport session, live
admission is capped, idle and absolute lifetimes are finite, and termination drains pipe
events before removing registry ownership.

Defaults:

```ts
export const CURSOR_BACKGROUND_SHELL_MAX_LIVE = 8;
export const CURSOR_BACKGROUND_SHELL_IDLE_MS = 5 * 60_000;
export const CURSOR_BACKGROUND_SHELL_ABSOLUTE_MS = 30 * 60_000;
export const CURSOR_BACKGROUND_SHELL_TERM_GRACE_MS = 2_000;
```

Eight allows several concurrent development servers/commands without turning a remote
Cursor session into an unbounded process supervisor. Five idle minutes covers interactive
stdin pauses; 30 minutes is an escape hatch for forgotten long-lived children. These are
fixed safety constants, not new user configuration.

## Current anchors

- `src/adapters/cursor/native-exec-shell.ts:23-24` owns one process-wide map containing
  only child and output-length counter.
- `src/adapters/cursor/native-exec-shell.ts:215-243` spawns and registers without owner,
  count cap, timeout, or error cleanup.
- `src/adapters/cursor/native-exec-shell.ts:252-265` writes stdin by global numeric id,
  so a different transport can currently address another session's shell.
- `src/adapters/cursor/native-exec.ts:62-69,139-168` carries native exec context and
  dispatches background spawn/stdin.
- `src/adapters/cursor/live-transport.ts:385-425` already owns stable private
  `sessionId` at line 407 and builds `execContext`.
- `src/adapters/cursor/live-transport.ts:579-600` closes transport/MCP state but not
  background children.
- `src/types.ts:1126-1144` and English configuration docs keep native local exec opt-in;
  `src/adapters/cursor/native-exec.ts:147-157` rejects it by default.

## Registry diff

Modify `src/adapters/cursor/native-exec-shell.ts`:

```ts
interface BackgroundShellEntry {
  shellId: number;
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  outputLength: number;
  startedAt: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  absoluteTimer: ReturnType<typeof setTimeout>;
  terminating: Promise<void> | null;
}
const backgroundShells = new Map<number, BackgroundShellEntry>();

export class CursorBackgroundShellBusyError extends Error {
  readonly code = "background_shell_busy";
}
export function backgroundShellSpawnExec(
  execMsg: ExecServerMessage,
  sessionId: string,
): Uint8Array;
export function writeShellStdinExec(
  execMsg: ExecServerMessage,
  sessionId: string,
): Uint8Array;
export function terminateBackgroundShellsForSession(sessionId: string): Promise<void>;
export function backgroundShellMetrics(): {
  live: number; peak: number; rejected: number; idleKills: number; absoluteKills: number;
};
```

Admission at `backgroundShellSpawnExec()` is exact:

1. require non-empty session id;
2. if `backgroundShells.size >= 8`, return typed
   `BackgroundShellSpawnError{error:"background shell limit reached"}` before `spawn()`;
3. spawn child, attach `error`, `close`, stdout and stderr listeners, then insert one
   entry and arm both unrefed timers;
4. if insertion/listener setup fails, terminate the just-created child and return error;
5. numeric ids remain process-monotonic, but authorization always checks session id.

`writeShellStdinExec()` returns the existing typed unknown-shell error when absent and a
new typed `shell belongs to another session` error on owner mismatch. It never reveals
the owner id. A successful stdin write updates `lastActivityAt` and re-arms only the idle
timer. Any stdout/stderr data also increments `outputLength`, updates activity, and
re-arms idle.

## Controlled termination

Add one idempotent owner:

```ts
async function terminateBackgroundShell(
  entry: BackgroundShellEntry,
  reason: "session_close" | "idle" | "absolute",
): Promise<void>;
```

The sequence is fixed:

1. set/reuse `entry.terminating`; clear both timers;
2. call `stdin.end()` best-effort;
3. keep stdout/stderr listeners attached and call `resume()` so kernel pipes drain;
4. send ordinary termination (`child.kill()` / SIGTERM) and await `close`;
5. after 2 seconds, send SIGKILL best-effort and still await close for one bounded
   additional 2-second window;
6. delete only when `backgroundShells.get(shellId) === entry`; settle even if the child
   never emits close, and record a privacy-safe counter.

No stdout/stderr text is retained. “Drain output” means continue consuming pipe bytes
until close so the child cannot block on a full pipe; only the existing byte count is
kept. `close` and `error` both clear timers and compare/delete the exact owner.

Idle timeout calls the helper with `idle`; absolute timeout is never refreshed. Session
close snapshots only entries with matching `sessionId` and awaits all controlled
terminations. It cannot kill a different session's process.

## Transport ownership wiring

Modify `CursorNativeExecContext` at `src/adapters/cursor/native-exec.ts:62-69`:

```ts
sessionId?: string;
```

At `src/adapters/cursor/live-transport.ts:409-425`, include
`sessionId: this.sessionId` in the initial context. Preserve it in the spread-based
reassignments at `:439-444` and `:501-505`. Dispatch spawn/stdin with that owner at
`src/adapters/cursor/native-exec.ts:166-167`; missing owner returns a typed error and
never spawns/writes.

Change `LiveCursorTransport.close()` and `cancelCursorRun()` at
`src/adapters/cursor/live-transport.ts:579-600` to start
`terminateBackgroundShellsForSession(this.sessionId)`. Because the public `close()`
signature is synchronous, retain one `shellCleanup` promise and let the transport's
existing async close/dispose path await it where available; repeated close calls share
the same cleanup. Process shutdown adds a global drain only after all transport-owned
cleanup has been requested.

## Disabled-by-default contract

Do not change `cursorUnsafeNativeLocalExecEnabled()` at
`src/adapters/cursor/native-exec.ts:71-73` or the rejection dispatch at `:147-157`.
No new config field enables shells. `nativeLocalExec` remains `"off"` by default and
`"codex-sandbox"` remains fail-closed. The legacy unsafe boolean remains compatibility
only; docs keep warning that the opt-in bypasses Codex approvals/sandboxing.

## Regression cases

Extend `tests/cursor-native-exec-shell.test.ts` with injected spawn/timer seams:

- `eight live background shells are admitted and the ninth is rejected before spawn`
- `close removes the exact child only after its output pipes drain`
- `idle lifetime terminates after five minutes and stdin activity rearms idle`
- `absolute lifetime terminates after thirty minutes despite activity`
- `controlled termination sends graceful kill before forced kill`
- `a child that never closes cannot retain the registry forever`
- `session cleanup terminates only shells owned by that session`
- `cross-session stdin write is rejected without revealing owner identity`
- `close and error races delete only the current map owner`
- `metrics contain counts only and reset deterministically`.

Extend `tests/cursor-native-exec.test.ts:354-375`:

- `background shell spawn and stdin share the transport session owner`
- `disabled native exec rejects background spawn before lifecycle admission`.

Extend `tests/cursor-native-exec-policy.test.ts:250-285`:

- `default off and codex-sandbox never create a background process`
- `only explicit nativeLocalExec on reaches bounded shell admission`.

Verification:

```bash
bun test tests/cursor-native-exec-shell.test.ts tests/cursor-native-exec.test.ts \
  tests/cursor-native-exec-policy.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`fix(cursor): bound background shell ownership and lifetime`

## Explicitly not changed

- No default enablement, daemonization, output-text retention, shell-id persistence, or
  cross-session control.
- No blind LRU eviction of a live child and no process kill before owner resolution.
- No change to foreground shell semantics, MCP/desktop executors, or Cursor protobufs.
