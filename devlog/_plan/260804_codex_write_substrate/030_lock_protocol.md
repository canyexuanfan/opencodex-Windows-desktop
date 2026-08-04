# WP11 — one bounded writer per canonical `CODEX_HOME`

Research: `003_lock_protocol.md`. Read it first; this document is the implementation
diff for its Decision.

The failure is lock splitting plus event-loop denial, not a missing mutex. Today the
default home can remain an unresolved `~/.codex` spelling while an explicit home is
realpathed (`src/codex/paths.ts:6-24`), and the nearest reusable SQLite lock opens a
stable file but repairs its mode after open (`src/codex/native-main-lock-file.ts:74-131`).
The rejected Codex-OFF design could therefore let two spellings of one home take two
locks, or wait synchronously around history work that can exceed 10.5 seconds
(`devlog/_plan/260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md:17-30`).
WP9 and WP10 land first: WP9 supplies an already-gathered, fixed-size synchronous
catalog commit (`001_catalog_seam.md:137-159`), and WP10 moves unbounded history work
to an owned Worker (`002_history_off_the_loop.md:264-296,474-486`). This phase adds
only the async cross-process acquisition substrate around those bounded commit
sections. It does not add desired state or decide ownership.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`7e67a8d06311de2471b0a25e41cf85f97007cc69`.

## IN / OUT

IN:

- `src/codex/codex-write-lock.ts` (**NEW**) — canonical-home resolution, namespace
  validation, finite async retry, admission callbacks, and the synchronous locked
  callback.
- `src/codex/native-main-lock-file.ts` (**MODIFY**) — preserve its existing stable
  descriptor owner and add only a caller-supplied ACL time cap. WP11 reuses
  `openStableLockFile`/`assertStableLockFile`; it does not copy their descriptor
  lifetime or `(dev, ino)` substitution checks.
- `src/lib/windows-secret-acl.ts` (**MODIFY**) — allow a stricter caller deadline to
  cap the existing required `icacls` sequence. Existing callers retain the current
  5-second default.
- `tests/codex-write-lock.test.ts` (**NEW**) — result taxonomy, canonicalization,
  namespace refusal, sync-callback, reentrancy, deadline, and real-process coverage.
- `tests/helpers/codex-write-lock-child.ts` (**NEW**) — an owned Bun process that
  acquires the real SQLite transaction and holds one finite synchronous section.
- `tests/windows-secret-acl.test.ts` (**MODIFY**) — prove the optional caller cap is
  forwarded without weakening the required ACL failure behavior.

OUT:

- `src/config.ts` — `withConfigMutationLockSync` stays synchronous and fail-fast;
  changing it would recreate the listener freeze its docstring prevents
  (`src/config.ts:1767-1818`).
- WP9 catalog gather/commit implementation, WP10 history Worker implementation,
  and all of WP12 ownership, desired-state, provenance, convergence, API, CLI, GUI,
  and docs wiring.
- `src/codex/paths.ts` global behavior. WP11 canonicalizes for the lock without
  changing every existing `CODEX_HOME` consumer at module import.
- PID files, heartbeat rows, leases, stale-file deletion, lock-database unlink,
  FIFO tickets, and process-local queueing.
- `gui/**`, service lifecycle, proxy start/stop/sync/restore/ensure, release, deploy,
  and the live proxy on port 10100.

No-code/configuration reuse is insufficient: process-local flights do not coordinate
two processes, and the existing native-main databases live inside `CODEX_HOME` and
have different lifetime semantics. Reusing the stable-file owner is sufficient for
the dangerous descriptor/open race, so this phase extends that owner instead of
adding another raw `openSync` implementation.

## API and ownership boundary

### Public contract

Add the following real TypeScript contract at the top of
`src/codex/codex-write-lock.ts`:

```ts
export const CODEX_WRITE_LOCK_MAX_TIMEOUT_MS = 30_000;

export type CodexWriteLockRefusalReason =
  | "codex_home_missing"
  | "codex_home_unsafe"
  | "authority_not_proven"
  | "namespace_unsafe"
  | "lock_path_unsafe"
  | "unsupported_filesystem"
  | "reentrant"
  | "lock_unavailable";

export type CodexWriteLockResult<T> =
  | {
      status: "acquired";
      value: T;
      waitedMs: number;
      lockId: string;
    }
  | {
      status: "busy";
      reason: "deadline" | "cancelled";
      retryable: true;
      waitedMs: number;
    }
  | {
      status: "refused";
      reason: CodexWriteLockRefusalReason;
      retryable: false;
      message: string;
    };

export type CodexWriteLockAdmissionPhase = "before_namespace" | "under_lock";

export type CodexWriteLockAdmissionResult =
  | { status: "admitted" }
  | { status: "refused"; message: string };

export interface CodexWriteLockContext {
  readonly canonicalCodexHome: string;
  readonly lockId: string;
}

export interface CodexWriteLockOptions {
  /**
   * Optional explicit target. When absent, a nonblank process CODEX_HOME wins;
   * otherwise defaultCodexHome() supplies ~/.codex or the existing WSL default.
   * Explicit and default targets pass through the same existing-directory
   * realpath algorithm before identity or namespace work.
   */
  codexHome?: string;

  /**
   * Required total acquisition budget in milliseconds, including namespace ACL
   * validation and every BEGIN IMMEDIATE attempt. Must be finite, integral, and
   * within 0..CODEX_WRITE_LOCK_MAX_TIMEOUT_MS. Zero performs one fail-fast attempt.
   */
  timeoutMs: number;

  /** Cancellation is a typed busy outcome; it is never thrown as contention. */
  signal?: AbortSignal;

  /**
   * Read-only WP12 admission. It runs once after canonical-home resolution but
   * BEFORE this module creates or opens a namespace entry, then again while the
   * SQLite transaction is held. The lock proves exclusion only; an admission
   * callback must independently prove service-home, external-provider, journal,
   * provenance, and desired-state authority.
   */
  admit(
    phase: CodexWriteLockAdmissionPhase,
    context: CodexWriteLockContext,
  ): CodexWriteLockAdmissionResult;
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Acquire the per-canonical-CODEX_HOME cross-process write lock, execute one
 * synchronous bounded commit, and release the SQLite transaction before this
 * Promise resolves.
 *
 * Waiting is asynchronous and barging-allowed: SQLITE_BUSY closes candidate
 * handles, sleeps with bounded jitter, and retries only until timeoutMs. The
 * locked callback itself MUST NOT return a Promise or perform provider I/O,
 * subprocess work, history walking, retry sleeps, or any other awaitable work.
 * WP9 prepares catalog bytes before this call; WP10 owns history in a Worker.
 * Keeping only their fixed commit/admission work here prevents a lock holder from
 * becoming the event-loop outage that blocked the earlier OFF design.
 *
 * Contention, cancellation, filesystem validation, ACL failure, and SQLite-open
 * failure return busy/refused. Invalid timing arguments and exceptions thrown by
 * the caller's admission or locked callback remain programmer/domain exceptions.
 */
export async function withCodexWriteLock<T>(
  options: CodexWriteLockOptions,
  locked: (context: CodexWriteLockContext) => Synchronous<T>,
): Promise<CodexWriteLockResult<T>>;
```

There is deliberately no public handle and no `release()` method. A handle would
let a caller retain the transaction across an `await`, making “bounded” a comment
rather than an API boundary. The conditional return type rejects an ordinary
`async` callback at typecheck; the implementation also checks for a thenable after
invocation, rolls back immediately, and throws `TypeError` as a programmer error.
It never awaits a callback result.

This narrows the research-level allowance at `003_lock_protocol.md:198-201` without
changing its Decision: acquisition remains async; the held operation is now
synchronous because WP9/WP10 remove the two reasons it previously needed to await.
The roadmap already records this stronger construction at `000_plan.md:105-109`.

### Admission order

The implementation order is fixed:

```text
resolve existing canonical CODEX_HOME                    read-only
derive lockId and detect same-task reentrancy             read-only
options.admit("before_namespace", context)                read-only
  refused -> return authority_not_proven; create NOTHING
resolve/validate real login home                          read-only
validate/create each private namespace component
validate/open stable database and BEGIN IMMEDIATE
options.admit("under_lock", context)                      read-only
  refused -> rollback/close; do not run locked callback
locked(context)                                           synchronous, bounded
assert stable path, ROLLBACK, close SQLite, close side fd
```

The callback names “admission”, not “ownership receipt”, because WP11 must not
manufacture a token that WP12 could accidentally treat as authority. The first call
closes the creation-before-knowledge bug; the second closes the check/lock race.
An `acquired` result means both admissions passed and the callback ran under the OS
transaction. It does not mean OpenCodex owns every artifact the callback might name.

## Canonicalization — C6

### Exact algorithm

`canonicalCodexHome(options)` implements these steps, in this order:

1. Select raw input as `options.codexHome` when it is nonblank; otherwise use a
   nonblank `process.env.CODEX_HOME`; otherwise call `defaultCodexHome()`. This
   retains today's default/WSL precedence (`src/codex/home.ts:121-146`). A supplied
   blank `options.codexHome` is a programmer error, not a request for default.
2. Expand only a leading `~` through the existing `expandUserPath`, then `resolve`
   to an absolute path. Do not lowercase, Unicode-normalize, or append unresolved
   suffixes.
3. `statSync` the target. `ENOENT`/`ENOTDIR` returns
   `refused/codex_home_missing`; another read error or a non-directory returns
   `refused/codex_home_unsafe`. No namespace function has run yet.
4. Call `realpathSync.native` for **both** default and explicit input. This collapses
   `~`, dot segments, trailing separators, and every symlink in the existing path.
5. On Windows only, feed `win32.normalize(realPath).toLowerCase()` to the hash. The
   existing diagnostics already compare Windows paths case-insensitively
   (`src/codex/home.ts:164-183`). On macOS and Linux, hash the exact string returned
   by `realpathSync.native`.
6. Refuse the already-recognized unsupported target classes: Windows UNC homes and
   WSL `/mnt/<drive>` homes, using `nativeMainOwnerFilesystemSupported`
   (`src/codex/native-main-owner.ts:75-91`). This phase does not claim portable
   lock identity across network hosts or filesystem namespaces.
7. Hash exactly
   `"opencodex-codex-write-lock-v1\0" + normalizedCanonicalHome` as UTF-8 with
   SHA-256, lowercase hex, all 64 characters.

For an existing case-insensitive macOS directory, `realpathSync.native` returns the
filesystem's stored directory-entry spelling, so `/Users/A/.CODEX` and
`/Users/A/.codex` converge. On a case-sensitive APFS volume, those can be two real
directories and must remain two identities. Windows can case-fold safely because a
single Windows namespace does not distinguish those spellings. Linux remains
case-sensitive.

Two consequences are acceptance requirements, not examples:

- default `~/.codex`, explicit `~/.codex`, its absolute spelling, and any symlink
  to that same existing directory contend on one SQLite file;
- two different existing directories produce different 64-character IDs and can
  acquire concurrently.

### The missing-home question

Missing homes are refused before hashing and before resolving the login-home lock
namespace. There is no portable alternative. If WP11 canonicalized the deepest
existing parent and preserved the absent suffix, `Foo` and `foo` would split one
future home on case-insensitive APFS. If it lowercased the suffix, they would alias
two future homes on case-sensitive APFS. Until the directory exists there is no
inode, filesystem-returned spelling, or case-behavior answer. Creation/installation
of `CODEX_HOME` is therefore another operation and another lock domain.

The implementation hunk in the new module is:

```diff
diff --git a/src/codex/codex-write-lock.ts b/src/codex/codex-write-lock.ts
new file mode 100644
--- /dev/null
+++ b/src/codex/codex-write-lock.ts
@@
+import { createHash } from "node:crypto";
+import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
+import { homedir } from "node:os";
+import { join, resolve, win32 } from "node:path";
+import { AsyncLocalStorage } from "node:async_hooks";
+import { Database } from "bun:sqlite";
+
+import { expandUserPath } from "../config";
+import { hardenSecretDirAsync } from "../lib/windows-secret-acl";
+import { defaultCodexHome } from "./home";
+import {
+  assertStableLockFile,
+  hardenStableLockFile,
+  openStableLockFile,
+  StableLockPathUnsafeError,
+  type StableLockFile,
+} from "./native-main-lock-file";
+import { nativeMainOwnerFilesystemSupported } from "./native-main-owner";
+
+const LOCK_DOMAIN = "opencodex-codex-write-lock-v1\0";
+const LOCK_NAMESPACE_PARTS = [".opencodex", "native-write-locks", "v1"] as const;
+const heldHomes = new AsyncLocalStorage<ReadonlySet<string>>();
+
+function normalizeCanonicalHome(path: string, platform = process.platform): string {
+  return platform === "win32" ? win32.normalize(path).toLowerCase() : path;
+}
+
+function lockIdFor(canonicalCodexHome: string): string {
+  return createHash("sha256")
+    .update(LOCK_DOMAIN)
+    .update(canonicalCodexHome)
+    .digest("hex");
+}
+
+function rawCodexHome(explicit: string | undefined): string {
+  if (explicit !== undefined) {
+    if (!explicit.trim()) throw new TypeError("codexHome must not be blank");
+    return explicit;
+  }
+  return process.env.CODEX_HOME?.trim() || defaultCodexHome();
+}
+
+function canonicalCodexHome(explicit: string | undefined):
+  | { status: "ok"; path: string }
+  | Extract<CodexWriteLockResult<never>, { status: "refused" }> {
+  const absolute = resolve(expandUserPath(rawCodexHome(explicit)));
+  try {
+    if (!statSync(absolute).isDirectory()) {
+      return refused("codex_home_unsafe", "CODEX_HOME is not an existing directory.");
+    }
+    const real = realpathSync.native(absolute);
+    if (!nativeMainOwnerFilesystemSupported(real)) {
+      return refused("unsupported_filesystem", "CODEX_HOME uses an unsupported filesystem identity.");
+    }
+    return { status: "ok", path: normalizeCanonicalHome(real) };
+  } catch (error) {
+    const code = errorCode(error);
+    return code === "ENOENT" || code === "ENOTDIR"
+      ? refused("codex_home_missing", "CODEX_HOME must exist before native writes can be locked.")
+      : refused("codex_home_unsafe", "CODEX_HOME could not be resolved safely.");
+  }
+}
```

`refused` and `errorCode` are private constructors in the same file; messages never
include the raw path or username.

## Namespace and hardening — C7

### Exact path

The namespace is independent of both `CODEX_HOME` and `OPENCODEX_HOME`:

```text
realpathSync.native(homedir())
  /.opencodex
  /native-write-locks
  /v1
  /<full lowercase sha256>.sqlite
```

The login home itself may resolve through a symlink because it is immediately
realpathed. The three OpenCodex-owned descendants may not be symlinks, junctions,
or other path substitutions. A custom `OPENCODEX_HOME` never changes this path.

### Component validation

`ensurePrivateLockNamespace(deadline)` walks one component at a time; it never uses
recursive `mkdir`:

1. Resolve and `stat` the login home, then `realpathSync.native` it.
2. For each descendant, `lstat` first. `ENOENT` permits one `mkdirSync(path,
   { mode: 0o700 })`; `EEXIST` restarts validation. Any existing non-directory,
   symlink, junction/reparse redirect, or realpath mismatch returns
   `refused/namespace_unsafe`.
3. On POSIX, require `process.getuid()` and exact `(mode & 0o7777) === 0o700` plus
   `stats.uid === process.getuid()`. Existing broader/narrower modes and another
   uid are refused; WP11 never chmods, renames, unlinks, or recreates them.
4. On Windows, compare case-folded `resolve(path)` and `realpathSync.native(path)`
   to reject junction/reparse redirection, then run the existing async directory
   ACL owner with `required: true` and the remaining outer deadline. A failed or
   timed-out required ACL operation returns `refused/namespace_unsafe`; it never
   proceeds to SQLite. The helper grants only the current user before removing
   inheritance and broad SIDs (`src/lib/windows-secret-acl.ts:217-328,404-494`).
5. Re-`lstat` and re-run identity/mode checks after creation/hardening before
   descending to the next component.

For the database and SQLite sidecars:

- Before open, any existing `<id>.sqlite` or `<id>.sqlite-journal` must be a regular
  non-symlink entry; on POSIX it must have the same uid and exact `0600` mode.
- Existing `-wal` or `-shm` is refused as `lock_path_unsafe`. WP11 forces rollback
  journal mode, so those names are unexpected state, not files to clean up.
- `openStableLockFile` performs `O_NOFOLLOW` on POSIX, then `fstat`; its retained
  side descriptor and reference count prevent a sibling close from releasing this
  process's SQLite lock (`src/codex/native-main-lock-file.ts:35-55,74-125`).
- After open, validate the descriptor's regular-file/uid/mode metadata, compare
  path `(dev, ino)` through `assertStableLockFile`, run required Windows file ACL
  hardening within the remaining deadline, and assert identity again before SQLite.
- SQLite executes `PRAGMA busy_timeout = 0`, `PRAGMA locking_mode = NORMAL`, verifies
  `PRAGMA journal_mode = DELETE`, then tries `BEGIN IMMEDIATE`. SQLite's OS lock is
  the only holder authority.
- Assert stable identity immediately after `BEGIN IMMEDIATE`, immediately before
  the synchronous callback, and once more before rollback/close. Close SQLite
  before closing the retained side descriptor.

Any validation failure before the locked callback maps to `refused/namespace_unsafe`
or `refused/lock_path_unsafe`; ACL/SQLite setup failures map to the narrower safe
reason when known, otherwise `refused/lock_unavailable`. The implementation does not
repair or delete the suspect entry. Diagnostics identify only the component role
(`v1 namespace`, `lock database`, `journal sidecar`), never its full home path.

The database persists after release. There is no `unlinkSync` in the module. A
crashed process loses its transaction when the OS closes SQLite; an old database
mtime or dead PID grants no takeover rights. A live hung process remains the holder,
and contenders return `busy/deadline`.

### Existing helper changes

The stable-file owner currently gives required Windows hardening its own fixed
deadline (`src/codex/native-main-lock-file.ts:127-131`). Add an optional caller cap
without changing existing call sites:

```diff
diff --git a/src/codex/native-main-lock-file.ts b/src/codex/native-main-lock-file.ts
--- a/src/codex/native-main-lock-file.ts
+++ b/src/codex/native-main-lock-file.ts
@@ -127,6 +127,10 @@
-export async function hardenStableLockFile(path: string): Promise<void> {
+export async function hardenStableLockFile(path: string, timeoutMs?: number): Promise<void> {
   try { chmodSync(path, 0o600); } catch { /* Windows ACL below is authoritative there. */ }
   if (process.platform === "win32") {
-    await hardenSecretPathAsync(path, { required: true, timeoutMemoKey: path });
+    await hardenSecretPathAsync(path, {
+      required: true,
+      timeoutMemoKey: path,
+      timeoutMs,
+    });
   }
 }
```

WP11 does **not** call `hardenStableLockFile` on POSIX: its unconditional `chmodSync`
is compatible with existing native-main users but forbidden for this strict namespace.
WP11 validates exact POSIX metadata instead. On Windows the existing ACL operation is
the authoritative platform control.

Cap the ACL helper's existing configured budget, leaving all current callers
unchanged:

```diff
diff --git a/src/lib/windows-secret-acl.ts b/src/lib/windows-secret-acl.ts
--- a/src/lib/windows-secret-acl.ts
+++ b/src/lib/windows-secret-acl.ts
@@ -53,2 +53,4 @@
   timeoutMemoKey?: string;
+  /** Optional stricter caller budget; never enlarges OPENCODEX_ACL_TIMEOUT_MS. */
+  timeoutMs?: number;
 }
@@ -68,7 +70,10 @@
-function resolveHardenDeadlineMs(): number {
+function resolveHardenDeadlineMs(opts: HardenOptions): number {
   const raw = env["OPENCODEX_ACL_TIMEOUT_MS"]?.trim();
-  if (!raw) return HARDEN_DEADLINE_DEFAULT_MS;
   const parsed = Number(raw);
-  if (!Number.isSafeInteger(parsed)) return HARDEN_DEADLINE_DEFAULT_MS;
-  return Math.min(HARDEN_DEADLINE_MAX_MS, Math.max(HARDEN_DEADLINE_MIN_MS, parsed));
+  const configured = raw && Number.isSafeInteger(parsed)
+    ? Math.min(HARDEN_DEADLINE_MAX_MS, Math.max(HARDEN_DEADLINE_MIN_MS, parsed))
+    : HARDEN_DEADLINE_DEFAULT_MS;
+  if (opts.timeoutMs === undefined) return configured;
+  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) return 1;
+  return Math.max(1, Math.min(configured, Math.floor(opts.timeoutMs)));
 }
@@ -426 +431 @@ function hardenEntry(
-  const deadline = nowFn() + resolveHardenDeadlineMs();
+  const deadline = nowFn() + resolveHardenDeadlineMs(opts);
@@ -470 +475 @@ async function hardenEntryAsync(
-  const deadline = nowFn() + resolveHardenDeadlineMs();
+  const deadline = nowFn() + resolveHardenDeadlineMs(opts);
```

The `tests/windows-secret-acl.test.ts` addition injects the existing async runner,
calls `hardenSecretDirAsync(path, { required: true, timeoutMs: 37 })`, and asserts
every runner invocation receives `<= 37`; a failed runner still rejects. This is a
deadline plumbing test, not an ACL mock standing in for the Windows CI job.

## Acquisition loop, release, and reentrancy — C5

The core new-file hunk is:

```diff
diff --git a/src/codex/codex-write-lock.ts b/src/codex/codex-write-lock.ts
new file mode 100644
--- /dev/null
+++ b/src/codex/codex-write-lock.ts
@@
+const RETRY_MIN_MS = 25;
+const RETRY_MAX_MS = 75;
+
+function isBusy(error: unknown): boolean {
+  const code = errorCode(error);
+  const message = error instanceof Error ? error.message : String(error);
+  return code === "SQLITE_BUSY"
+    || code === "SQLITE_LOCKED"
+    || /database (?:is|table is) locked/i.test(message);
+}
+
+function jitter(random = Math.random): number {
+  return RETRY_MIN_MS + Math.floor(random() * (RETRY_MAX_MS - RETRY_MIN_MS + 1));
+}
+
+async function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
+  if (signal?.aborted) return false;
+  return new Promise(resolveSleep => {
+    let settled = false;
+    const finish = (completed: boolean): void => {
+      if (settled) return;
+      settled = true;
+      clearTimeout(timer);
+      signal?.removeEventListener("abort", onAbort);
+      resolveSleep(completed);
+    };
+    const onAbort = (): void => finish(false);
+    const timer = setTimeout(() => finish(true), ms);
+    signal?.addEventListener("abort", onAbort, { once: true });
+  });
+}
+
+function release(database: Database | undefined, file: StableLockFile | undefined): void {
+  try { database?.exec("ROLLBACK"); } catch { /* close remains the OS release */ }
+  try { database?.close(); } catch { /* transaction is already ending */ }
+  try { file?.close(); } catch { /* SQLite closed before the side descriptor */ }
+}
+
+export async function withCodexWriteLock<T>(
+  options: CodexWriteLockOptions,
+  locked: (context: CodexWriteLockContext) => Synchronous<T>,
+): Promise<CodexWriteLockResult<T>> {
+  assertTimeout(options.timeoutMs);
+  const startedAt = performance.now();
+  const deadline = startedAt + options.timeoutMs;
+  const canonical = canonicalCodexHome(options.codexHome);
+  if (canonical.status !== "ok") return canonical;
+  const lockId = lockIdFor(canonical.path);
+  const context = { canonicalCodexHome: canonical.path, lockId } as const;
+  if (heldHomes.getStore()?.has(canonical.path)) {
+    return refused("reentrant", "A nested Codex write attempted to acquire the same home.");
+  }
+  if (options.signal?.aborted) return busy("cancelled", startedAt);
+  const preflight = options.admit("before_namespace", context);
+  if (preflight.status === "refused") {
+    return refused("authority_not_proven", preflight.message);
+  }
+
+  return heldHomes.run(new Set([...(heldHomes.getStore() ?? []), canonical.path]), async () => {
+    const target = await ensurePrivateLockTarget(lockId, deadline);
+    if (target.status !== "ok") return target;
+    let attempted = false;
+    for (;;) {
+      let file: StableLockFile | undefined;
+      let database: Database | undefined;
+      let callerCodeStarted = false;
+      try {
+        attempted = true;
+        ({ file, database } = await openCandidate(target, deadline));
+        database.exec("BEGIN IMMEDIATE");
+        assertStableLockFile(target.databasePath, file);
+        callerCodeStarted = true;
+        const underLock = options.admit("under_lock", context);
+        if (underLock.status === "refused") {
+          release(database, file);
+          return refused("authority_not_proven", underLock.message);
+        }
+        assertStableLockFile(target.databasePath, file);
+        const value = locked(context);
+        if (value && typeof value === "object" && "then" in value) {
+          throw new TypeError("Codex write locked callback must be synchronous");
+        }
+        callerCodeStarted = false;
+        assertStableLockFile(target.databasePath, file);
+        release(database, file);
+        return { status: "acquired", value, waitedMs: elapsed(startedAt), lockId };
+      } catch (error) {
+        release(database, file);
+        if (callerCodeStarted) throw error;
+        if (!isBusy(error)) return mapAcquireRefusal(error);
+        if (options.signal?.aborted) return busy("cancelled", startedAt);
+        const remaining = deadline - performance.now();
+        if (attempted && remaining <= 0) return busy("deadline", startedAt);
+        const slept = await abortableSleep(Math.min(jitter(), remaining), options.signal);
+        if (!slept) return busy("cancelled", startedAt);
+      }
+    }
+  });
+}
```

`ensurePrivateLockTarget` and `openCandidate` implement the namespace rules above.
`openCandidate` always closes both handles on failure and maps
`StableLockPathUnsafeError` to `lock_path_unsafe`. It validates sidecars afresh on
every retry because another process may replace a path while this contender sleeps.

The timeout is monotonic (`performance.now`), required, and total. A zero timeout
still gets exactly one `BEGIN IMMEDIATE`; if busy, it returns immediately. No SQLite
busy timeout, ACL subprocess, or retry sleep may exceed the remaining outer budget.
Jitter is uniformly bounded to integer 25–75 ms and clipped to the deadline.
Contenders may barge after any sleep; no test or caller may infer FIFO order.

Only `SQLITE_BUSY`/`SQLITE_LOCKED` enters the retry loop. Filesystem, ACL, malformed
database, unexpected journal mode, identity, and permission failures are refusals,
not contention. There is no catch that turns callback exceptions into `busy` or
`refused`; after release they propagate unchanged.

## Deadlock order and current inverse-nesting proof

The only legal nested order is:

```text
Codex write lock (async acquisition; synchronous held callback)
  -> withConfigMutationLockSync / mutatePersistedConfig
     -> return before the Codex callback returns
  -> fixed native commit
-> release Codex write lock
```

Never call `withCodexWriteLock` from inside `withConfigMutationLockSync`, from a
`mutatePersistedConfig` mutation callback, or from a helper reached by either
callback. Outer config contention remains `ConfigMutationLockError`; WP12 may retry
that synchronous acquisition only while the outer Codex deadline remains. It must
not release and silently reorder the requested state change.

Fresh search on the current tree found no inverse edge:

```text
$ rg -n 'withConfigMutationLockSync\(|mutatePersistedConfig\(' src --glob '*.ts'
src/config.ts:1829:  withConfigMutationLockSync(() => persistConfigUnlocked(config));
src/config.ts:1870:  return withConfigMutationLockSync(() => {
src/config.ts:2145:  withConfigMutationLockSync(() => {
src/codex/account-store.ts:281:    return withConfigMutationLockSync(fn);
src/codex/auth-api.ts:670:    outcome = mutatePersistedConfig(persistedConfig => {
```

The three config-owned sections perform config snapshots/persistence only
(`src/config.ts:1821-1829,1861-1913,2144-2176`). The account wrapper is a direct
typed-error translation (`src/codex/account-store.ts:278-285`). The sole external
`mutatePersistedConfig` callback updates plan strings and performs no Codex native
operation (`src/codex/auth-api.ts:660-701`). None imports the new module today.
Therefore adding the future WP12 edge `codex-write -> config` cannot close a cycle
in the current graph.

Add a source-shape case to `tests/codex-write-lock.test.ts` that reruns this inventory
over `src/config.ts`, `src/codex/account-store.ts`, and `src/codex/auth-api.ts`, and
fails if `codex-write-lock` or `withCodexWriteLock` appears inside an existing
config-lock callback. This test protects inverse nesting; it does not reject a WP12
orchestrator that correctly acquires Codex first and calls config second.

## Test plan

### `tests/helpers/codex-write-lock-child.ts` (NEW)

The helper accepts `CODEX_HOME`, `HOLD_MS`, and marker paths through its environment.
It calls the production `withCodexWriteLock` with a 5-second deadline and an
always-admitted test callback, writes `READY_PATH`, then executes one finite
`Bun.sleepSync(HOLD_MS)` inside the synchronous locked callback. It prints the typed
result as one JSON line and exits nonzero unless status is `acquired`. It never
opens SQLite directly; contention must exercise the production namespace and API.

### `tests/codex-write-lock.test.ts` (NEW)

Every test creates both a fake login home and existing Codex homes below one test
root, sets `HOME`/`USERPROFILE`, and restores them in `afterEach`. It never resolves
the real user's `.codex` or `.opencodex`.

1. **Real two-process exclusion and barging contract.** Spawn the child on home A,
   wait for its ready marker, then call the production API in the parent. A 100 ms
   deadline returns `{ status:"busy", reason:"deadline" }` and the parent callback
   does not run. A second parent waiter with 2 s acquires after the child's bounded
   release. A timer increments while waiting, proving retry sleep is async. Assert
   exclusion and eventual two-party acquisition only, never arrival order.
2. **Crash release, no stale recovery.** Child acquires and exits from inside its
   callback. After its zero exit, parent acquires the persistent database without
   unlink, PID, mtime, quarantine, or recovery marker. This mirrors the existing
   OS-release proof (`tests/config-mutation-lock.test.ts:105-129`).
3. **Live holder is never stolen.** Hold longer than two successive parent deadlines;
   both return busy, the database inode is unchanged, and no path is removed. Age is
   not takeover authority.
4. **Deadline and cancellation.** Zero gets one fail-fast attempt; finite expiry is
   typed busy; an already-aborted signal returns `busy/cancelled`; a signal fired
   during jitter cancels the timer and returns the same. None throws contention.
5. **Callback boundary.** A synchronous value appears in `acquired.value`; a thrown
   domain error propagates after release; an `async` callback is a compile-time
   `@ts-expect-error`; a cast thenable activates the runtime `TypeError` and releases
   the lock for a later call.
6. **Admission order.** `before_namespace` refusal leaves
   `.opencodex/native-write-locks` absent. Under-lock refusal may leave the persistent
   database but never calls the locked callback. Record phase order exactly as
   `before_namespace, under_lock, locked`.
7. **Same-task reentrancy.** Calling the API again for the same canonical home from
   the callback returns `refused/reentrant` without waiting. A separately started
   same-process task is an ordinary contender and acquires after release.
8. **Default/explicit/absolute/tilde.** With default login `.codex` existing, delete
   `CODEX_HOME` and have the child hold the default spelling. Parent attempts using
   explicit `~/.codex` and the absolute path both return busy on the same `lockId`.
9. **Symlinked home.** Child holds a real directory; parent targets a symlink to it.
   The parent is busy and the one expected full-hash database exists. Reverse the
   spellings so the default itself is the symlink; the result is identical.
10. **Case behavior.** Create `CaseHome`, then probe `casehome`. If the platform
    resolves both to the same existing directory, assert contention and one ID. If
    the alternate spelling is missing, first assert `codex_home_missing` creates no
    namespace; then create the second directory and assert both acquire concurrently
    with distinct IDs. On Windows, slash and drive-letter case variants also share
    one ID.
11. **Distinct homes.** Hold home A in the child and acquire home B immediately in
    the parent. Assert two different 64-hex IDs and database paths.
12. **Missing home.** Test explicit and default missing paths. Both return
    `codex_home_missing`, `admit` is not called, and the fake login home still has no
    `.opencodex` descendant. This activates the case-sensitive/case-insensitive
    resolution rather than testing only a pure hash helper.
13. **Namespace symlinks.** Independently replace `.opencodex`,
    `native-write-locks`, and `v1` with a real symlink/junction. Each returns
    `namespace_unsafe`, preserves the entry/target byte-for-byte, and creates no DB.
14. **Database/sidecar substitution.** A symlink database, symlink `-journal`, or
    existing `-wal`/`-shm` returns `lock_path_unsafe` and is not removed. A test hook
    swaps the DB after stable open and proves `(dev, ino)` revalidation refuses.
15. **POSIX owner/mode.** Existing namespace modes `0755`/`0700` and DB modes
    `0644`/`0600` cover refusal/success. Inject a mismatched effective uid for the
    deterministic wrong-owner branch; when CI runs as uid 0, additionally `chown`
    a fixture and prove the real metadata branch. No test expects chmod repair.
16. **Windows ACL and junctions.** On `windows-latest`, create real directory
    junctions for each namespace component and require refusal. Inject the existing
    `icacls` runner for required failure/timeout mapping, while the normal success
    case runs the real required ACL path. UNC and WSL DrvFS identities return
    `unsupported_filesystem` through the existing predicate.
17. **Malformed database and rollback journal.** Preserve malformed bytes and return
    `lock_unavailable`; accept a same-owner/mode regular rollback journal, refuse
    wrong metadata, and never silently switch to WAL.
18. **Deadlock source shape.** Re-run the inventory described above and pin
    `Codex-write -> config`, with no inverse callback acquisition.

The wrong-owner uid injection is only for a branch a non-root CI process cannot
materialize. Symlink, mode, substitution, SQLite contention, process crash, and
deadline tests all use real filesystem/process behavior.

## Verification

No verification command starts, stops, syncs, restores, or ensures the proxy. Port
10100 remains untouched.

Run in this order after WP9 and WP10 are present and the diff is implemented:

```bash
bun test tests/codex-write-lock.test.ts --test-name-pattern "real two-process exclusion"
bun test tests/codex-write-lock.test.ts tests/windows-secret-acl.test.ts tests/native-main-claim.test.ts tests/native-main-owner-lifetime.test.ts tests/config-mutation-lock.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

The first command is the required real two-process contention run: the child holds
the production SQLite transaction, the parent expires once as typed `busy`, remains
event-loop responsive, then acquires after release. A mocked `SQLITE_BUSY`, two
connections in one process, or a pure lock-ID test does not satisfy it.

Run the focused test and typecheck on macOS, Linux, and Windows. Windows must execute
the real junction and ACL-success cases; POSIX must execute exact uid/mode checks.
The full suite is required because `native-main-lock-file.ts` and
`windows-secret-acl.ts` are shared owners even though their existing defaults are
preserved.

## Deliberate residuals

- `realpath` does not collapse bind-mount or filesystem-namespace aliases. Portable
  directory file identity and cross-host/network-filesystem coordination remain
  unsupported, as `003_lock_protocol.md:345-350` already marks **INFERRED**. WP11
  refuses the target classes the repository can identify; it does not claim every
  alias can be detected portably.
- The concrete 15-second OFF and 5-second startup/background budgets in
  `003_lock_protocol.md:173-176` remain caller-policy in WP12. WP11 enforces only the
  required finite `0..30_000` ms API bound.
- Creation of a missing `CODEX_HOME` remains a separate lock domain. No future WP12
  convenience path may weaken missing-home refusal in this module.

## Accept criteria

- **C5 — finite async acquisition and typed contention.** Every call supplies an
  integral `0..30_000` ms total deadline. Real cross-process `BEGIN IMMEDIATE`
  contention yields `busy/deadline`, cancellation yields `busy/cancelled`, ordinary
  acquisition yields `acquired`, and unsafe setup yields `refused`; contention is
  never an exception. Retry sleeps are async 25–75 ms bounded jitter, FIFO is not
  claimed, the locked callback is synchronous/bounded, and no PID/mtime takeover or
  stale-file unlink exists.
- **C6 — one identity per real home.** Both explicit and default homes require an
  existing directory and pass through `realpathSync.native`; Windows additionally
  normalizes/case-folds. Default, explicit, absolute, tilde, symlink, separator, and
  case-equivalent spellings contend on one full SHA-256 lock, while two different
  existing canonical directories acquire independently. A missing home refuses
  before admission, hashing side effects, or namespace creation.
- **C7 — private hardened namespace.** The database path is exactly
  `<real-login-home>/.opencodex/native-write-locks/v1/<full-sha256>.sqlite`, never
  `tmpdir`, `CODEX_HOME`, or `OPENCODEX_HOME`. POSIX requires real same-uid `0700`
  directories and a same-uid `0600` regular DB/rollback journal; Windows requires
  non-junction identity plus successful required per-user ACL hardening within the
  outer deadline. Symlink, wrong-owner/mode, substitution, WAL/SHM residue, ACL
  failure, and unsupported filesystem identity refuse without chmod repair, rename,
  unlink, or recreation.

WP11 is complete only when the focused real-process activation, cross-platform
hardening cases, typecheck, full tests, and privacy scan all pass. It still does not
authorize a native write: WP12 must supply the two read-only admissions and handle
config-lock retry/commit outcomes under this exclusion boundary.
