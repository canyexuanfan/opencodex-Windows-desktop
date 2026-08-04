# WP11 — one bounded writer per canonical `CODEX_HOME`

Research: `003_lock_protocol.md`. Shared contract: `005_contract.md`.

The failure is lock splitting plus event-loop denial, not a missing mutex. Two
spellings of one existing Codex home can reach different textual paths
(`src/codex/paths.ts:6-24`), while a lock held across provider discovery or history
walking would recreate the 10.5-second listener stall that blocked the previous OFF
design. WP9 has already made catalog commit synchronous and fixed-size; WP10 has
already put history behind its own sibling Worker-held lock. WP11 supplies only the
native acquisition and coordinated synchronous commit section.

The prior plan still invented admission callback/result types and based the
namespace on `homedir()`. Round 2 invalidated both choices. Admission is the
contract's exact `AdmissionSnapshot`; and the pinned Bun 1.3.14 probe showed both
`os.homedir()` and `os.userInfo().homedir` follow environment-controlled home.
Effective-user identity — uid on POSIX, SID on Windows — is the namespace authority
(`005_contract.md` §§4, 7).

WP11 is independently landable. It consumes WP8b's identity/transition-state/types,
WP9's synchronous candidate commit, and WP10's separate history protocol. The WP11
commit typechecks and preserves the working WP9/WP10 funnel. WP12 later supplies
stronger ownership/provenance decisions through the same `AdmissionSnapshot`; it is
not required to replace a placeholder before this phase works.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`7bde9e0c977721fc0b9d8617c85ff17de7c07658`.

## IN / OUT

IN:

- `src/codex/codex-write-lock.ts` (NEW) — exact contract module name; canonical
  target identity, effective-user namespace, finite async acquisition, synchronous
  coordinated commit, release, and typed lock mechanics.
- `src/codex/convergence.ts` (MODIFY) — place WP9's fixed catalog/native commit
  under the new lock and pass the contract `AdmissionSnapshot`/`CommitExpectation`.
- `src/codex/transition-state.ts` (MODIFY through its public owner API) — lend
  WP11 a narrow opaque capability backed by the already-open coordinator
  transaction; this module remains the sole native-generation/transition-row owner.
- `src/codex/integration-record.ts` (consumed through `updateIntegrationRecord`) —
  persist provenance/non-CAS JSON only inside the synchronous coordinated section.
- `src/codex/native-main-lock-file.ts` (MODIFY) — reuse stable descriptor and
  substitution checks; add only a caller-supplied ACL deadline cap.
- `src/lib/windows-secret-acl.ts` (MODIFY) — accept a stricter remaining deadline;
  current callers retain the 5-second default.
- `tests/codex-write-lock.test.ts` (NEW),
  `tests/helpers/codex-write-lock-child.ts` (NEW), and
  `tests/windows-secret-acl.test.ts` (MODIFY).

OUT:

- New admission, authority, generation, record, observed-state, or convergence
  result shapes. WP11 imports `AdmissionSnapshot`, `CommitExpectation`, and
  `UserIdentity` from the contract modules (`005_contract.md` §§1-4, 7). The
  native-lock result below remains owned by this lock module; it is a mechanism
  result projected by `convergence.ts`, not a competing convergence union.
- History mutation/locking. WP10 owns H and its two short fail-fast H->N
  operations; WP11 only ensures N is released before history dispatch.
- Transition-row schema, generation allocation, or JSON transition state. Those
  belong to `transition-state.ts`; `integrations/codex.json` contains provenance
  and extensions, never `nativeGeneration`, `currentTxId`, or history scheduling.
- Provider gathering or any awaited history work inside the native held section.
- Desired-state, service ownership, external-provider, journal, and provenance
  policy — WP12. WP11 compares snapshots and enforces order; it does not decide
  what `owned` means.
- `src/codex/paths.ts` global behavior, PID files, leases, stale-file deletion,
  FIFO tickets, process-local queueing, GUI, releases/deploys, and port 10100.

No-code/config reuse is insufficient: process-local flights do not coordinate two
processes. Reusing `native-main-lock-file.ts` is required for its stable descriptor
and `(dev, ino)` checks (`src/codex/native-main-lock-file.ts:35-55,74-131`); WP11
does not add another raw-open owner.

## Public contract consumes `AdmissionSnapshot`

The shared type names and result taxonomy already exist after WP8b. WP11 implements
them in `src/codex/codex-write-lock.ts`; it does not publish the former
`CodexWriteLockAdmissionPhase` or `CodexWriteLockAdmissionResult` unions.

```ts
import type {
  AdmissionSnapshot,
  BeginCodexTransition,
  CommitExpectation,
} from "./convergence-types";

export const CODEX_WRITE_LOCK_MAX_TIMEOUT_MS = 30_000;

export type CodexWriteLockResult<T> =
  | { status: "acquired"; value: T; waitedMs: number; lockId: string }
  | { status: "busy"; reason: "deadline" | "cancelled"; retryable: true; waitedMs: number }
  | {
      status: "refused";
      reason:
        | "codex_home_missing"
        | "codex_home_unsafe"
        | "authority_not_proven"
        | "namespace_unsafe"
        | "lock_path_unsafe"
        | "unsupported_filesystem"
        | "reentrant"
        | "lock_unavailable";
      retryable: false;
      message: string;
    };

export interface CodexWriteLockOptions {
  codexHome?: string;
  timeoutMs: number;
  signal?: AbortSignal;

  /** Read-only snapshot obtained before any namespace creation. */
  admitted: AdmissionSnapshot;

  /**
   * Authoritative synchronous re-read while native + config coordination is held.
   * It returns the exact shared shape; no lock-specific admission union exists.
   */
  readAdmissionUnderLock(): AdmissionSnapshot;
}

export interface CodexWriteCommitContext {
  readonly canonicalCodexHome: string;
  readonly lockId: string;
  readonly admission: AdmissionSnapshot;
  readonly expectation: CommitExpectation;
  /**
   * Opaque authority over the ALREADY-OPEN BEGIN IMMEDIATE transaction N.
   * It exposes one conditional row operation, not SQLite or transaction control.
   */
  readonly coordinator: CodexCoordinatorTransaction;
}

const codexCoordinatorTransactionBrand: unique symbol = Symbol(
  "CodexCoordinatorTransaction",
);

export interface CodexCoordinatorTransaction {
  readonly [codexCoordinatorTransactionBrand]: true;
  readonly beginTransition: BeginCodexTransition;
}

type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * A TYPE, not a bodyless declaration.
 *
 * `export async function f(...): Promise<T>;` with no body is TS2391, and a
 * reviewer has caught that exact form in this unit three separate rounds by
 * compiling the documents. Publishing the shape as a type makes the mistake
 * structurally impossible to reprint.
 */
export type WithCodexWriteLock = <T>(
  options: CodexWriteLockOptions,
  commit: (context: CodexWriteCommitContext) => Synchronous<T>,
) => Promise<CodexWriteLockResult<T>>;
```

`CodexWriteLockResult` is the lock module's own bounded mechanism result.
`convergence.ts` exhaustively projects it into `ConvergeOutcome`; no route consumes
it directly. `CodexCoordinatorTransaction` is the only handle passed to the
callback. It is branded and exposes only the contract's null-safe conditional
transition-row update. It is one-shot for this transition, and WP11 verifies that
it returned `updated` for the exact expectation before allowing C to release. It
exposes neither the `Database` object nor `COMMIT`,
`ROLLBACK`, or `close`. Opening another connection in the callback is wrong: it
would contend with WP11's own `BEGIN IMMEDIATE` instead of updating through N.
The conditional return rejects ordinary `async` callbacks at typecheck;
the implementation also detects a cast thenable, rolls back, and throws a
`TypeError`. Provider I/O, subprocesses, serialization, history walking, retry
sleeps, and any other awaitable work are forbidden beneath `commit`.

## Admission and synchronous config-record section

The fixed order is:

```text
resolve canonical existing CODEX_HOME                         read-only
derive lock id + detect same-task reentrancy                  read-only
compare options.admitted to target home                       read-only
  non-authorizing snapshot -> return refused; create NOTHING
resolve effective UserIdentity + OS runtime root              read-only
validate/create private user namespace
validate/open stable DB; BEGIN IMMEDIATE                      native lock held
withConfigMutationLockSync                                    config lock held
  authoritative readAdmissionUnderLock()                      fresh snapshot
  compare digest + config generation + intent + ownership
  read transition pair and form CommitExpectation             from row in N
  commit(context with opaque N capability)                    synchronous
    native writes + provenance-only integration-record update
    conditional transition-row update through the same N
  verify exact nativeAfter + txId on the still-open N
release config lock
assert stable lock path; COMMIT N; close DB + side fd
```

This replaces the former two generic admission callbacks. The first
`AdmissionSnapshot` is enough to refuse before namespace creation. The second is
an authoritative re-read inside the coordinated commit; WP11 does not reduce it to
a boolean or manufacture an authority receipt.

`withConfigMutationLockSync` is already synchronous, fail-fast, and reentrant only
for the current synchronous stack (`src/config.ts:1767-1818`). The native lock may
hold it because no await occurs. Config-generation reads/updates and
provenance-only `updateIntegrationRecord` calls happen before that callback returns.
The native generation bump, `txId`, and pending history schedule are owned by the
transition row and are conditionally updated through the capability backed by N.
WP11 verifies that exact row before C returns, releases C, and then commits N.

The previous version ended the successful path with `ROLLBACK`. That was wrong: it
discarded the transition row the whole design depends on, so a successful native
commit became indistinguishable from an unrecorded partial write and stale Workers
could not be rejected. `ROLLBACK N` remains only for callback failure, failed row
update/verification, cast-thenable rejection, or another refusal before commit.

If the config coordinator is busy, the attempt releases the native lock and retries
only while the outer monotonic deadline remains; deadline expiry returns typed
`busy`. It never releases and commits against the old admission. A non-cooperating
filesystem writer remains detectable after commit, as scoped by `005_contract.md`
§3; WP11 does not promise a portable conditional rename that `src/config.ts:1853-1859`
explicitly says the filesystem lacks.

## Canonical `CODEX_HOME` identity — C6

1. Select nonblank explicit `codexHome`, else nonblank `process.env.CODEX_HOME`,
   else `defaultCodexHome()` (`src/codex/home.ts:135-146`). Blank explicit input is
   a programmer error.
2. Expand only leading `~`, resolve absolute, and require an existing directory.
   Missing/non-directory refuses before identity namespace work.
3. `realpathSync.native` every spelling, default and explicit.
4. Refuse known unsupported UNC/WSL DrvFS target classes through the existing
   predicate (`src/codex/native-main-owner.ts:75-91`).
5. Windows normalizes/case-folds the canonical result; POSIX hashes the exact
   realpath string.
6. Hash `"opencodex-codex-write-lock-v1\0" + normalizedCanonicalHome` with full
   SHA-256 lowercase hex.

Default, explicit, absolute, tilde, and symlink spellings of one existing directory
must contend on one lock. Two distinct existing directories must not. A missing
home is refused: preserving an unresolved suffix would either split one future home
on case-insensitive filesystems or alias two on case-sensitive ones.

## Namespace and hardening — C7

### No home accessor participates

Delete `homedir()` from the import list and delete the prior
`realpathSync.native(homedir())/.opencodex/...` design. The pinned Bun probe in
`005_contract.md` §7 proves both home accessors can be changed by `HOME`; using
`os.userInfo().homedir` would preserve the defect.

Consume `UserIdentity` and the one final-path resolver from
`src/codex/user-identity.ts`:

```ts
import {
  resolveEffectiveUserIdentity,
  resolveCodexCoordinatorDatabasePath,
} from "./user-identity";
```

Call `resolveEffectiveUserIdentity()`, then pass that identity and the canonical
`CODEX_HOME` to `resolveCodexCoordinatorDatabasePath(...)`. Its return value is the
**final database path** and is consumed verbatim. WP11 does not import
`resolveOsRuntimeDirectory`, encode uid/SID, hash the home for path construction,
or append `opencodex`, `native-write-locks`, a version, or `.sqlite`. The prior
version reconstructed those segments locally; that was wrong because it let the
lock holder and transition-state callers open different databases despite the
contract's single resolver (`005_contract.md:861-877`).

### Component validation

Walk components one at a time; never recursive-mkdir across an unvalidated parent.

- Existing components are `lstat`ed and must be real directories, not symlinks,
  junctions, or reparse redirects. `ENOENT` permits one `mkdirSync(..., 0700)`,
  followed by the same validation.
- POSIX requires exact effective uid and mode `0700` for directories, `0600` for
  the DB/rollback journal. Wrong owner/mode refuses; WP11 does not chmod a suspect
  existing path.
- Windows validates non-junction identity and runs the existing required per-user
  ACL owner within the remaining outer deadline
  (`src/lib/windows-secret-acl.ts:217-328,404-494`). Failure/timeout refuses.
- Existing DB or `-journal` must be regular, same-user private entries. Existing
  `-wal`/`-shm` refuses; WP11 forces rollback journal mode.
- `openStableLockFile` retains the side descriptor; validate descriptor metadata,
  assert path identity before/after SQLite open, after `BEGIN IMMEDIATE`, before
  commit, and before close.
- SQLite uses `busy_timeout=0`, `locking_mode=NORMAL`, and verified
  `journal_mode=DELETE`. The OS transaction is holder authority.

The DB persists after release. There is no unlink, stale takeover, heartbeat, PID,
or mtime authority. Process death releases the OS lock; a live hung holder remains
the holder and contenders reach their deadline.

### Core new-module diff

```diff
+import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
+import { resolve, win32 } from "node:path";
+import { AsyncLocalStorage } from "node:async_hooks";
+import { Database } from "bun:sqlite";
+
+import { withConfigMutationLockSync } from "../config";
+import { updateIntegrationRecord } from "./integration-record";
+import {
+  resolveCodexCoordinatorDatabasePath,
+  resolveEffectiveUserIdentity,
+} from "./user-identity";
+
+function coordinatorDatabasePath(canonicalHome: string): string {
+  const identity = resolveEffectiveUserIdentity();
+  return resolveCodexCoordinatorDatabasePath(identity, canonicalHome);
+}
```

No `node:os` home accessor is imported.

## Acquisition, release, and reentrancy — C5

The total timeout is required, finite, integral, and within `0..30_000` ms.
Acquisition uses monotonic `performance.now()`. Zero receives one fail-fast
`BEGIN IMMEDIATE`. Only SQLite busy/locked retries; filesystem, ACL, malformed DB,
identity, permission, and journal-mode failures are refusals.

Retry sleeps are async uniformly bounded 25-75 ms, clipped to remaining deadline,
and abortable. Barging is allowed; no caller/test infers FIFO. Candidate SQLite and
side descriptors close after every failed attempt.

`AsyncLocalStorage<ReadonlySet<string>>` rejects same-task same-home reentrancy.
A separate task is an ordinary contender. Caller exceptions propagate after
rollback/release; they are never converted to busy/refused.

```diff
+const transaction = openCodexCoordinatorTransaction(finalDatabasePath);
+// transaction has already executed BEGIN IMMEDIATE: N is held here.
+const value = withConfigMutationLockSync(() => {
+  const current = options.readAdmissionUnderLock();
+  assertAdmissionStillCurrent(options.admitted, current);
+  const expectation = transaction.expectation();
+  const result = commit({
+    canonicalCodexHome,
+    lockId,
+    admission: current,
+    expectation,
+    coordinator: transaction.capability,
+  });
+  transaction.assertPublished(expectation);
+  return result;
+});
+transaction.assertStablePath();
+transaction.commit();
```

`openCodexCoordinatorTransaction` is a transition-state owner API, not a second
SQLite implementation in WP11. Its controller retains commit/rollback/close and
path-stability authority; only `transaction.capability` crosses into the callback.
`commit` must perform the conditional `beginTransition` after its native/provenance
writes. `assertPublished` rejects zero-row/conflict/unavailable or the wrong exact
pair before C is released. The callback performs no logging or response shaping.
Those occur after both locks release.

## Deadlock order and sibling history sequence

Legal order:

```text
native/coordinator transaction N (BEGIN IMMEDIATE)
  -> config transaction C
       -> authoritative AdmissionSnapshot re-read
       -> config generation read/update when config changes
       -> synchronous native commit
       -> provenance-only integration-record update
       -> conditional transition-row update through already-open N
  -> release C
  -> COMMIT N
-> release N

history lock (later, in Worker)
  -> fail-fast coordinator N claim check; if busy, release H and retry
  -> manifest + rollouts + DB + post-probe while holding H, not N
  -> fail-fast coordinator N terminal CAS; if busy, release H and retry
-> release history
```

The complete order is `N -> C` plus a short `H -> N`. There is no `C -> N`, no
`C -> H`, and no held `N -> H`. Native releases N before dispatching history. At
claim and terminal boundaries a Worker may hold H while attempting only a
fail-fast conditional operation on N; `SQLITE_BUSY` releases H and retries, so it
never waits while preserving the edge. Between those boundaries history traversal
holds H alone. A stale history job is generation/transaction-rejected before
mutation or loses the terminal CAS, so it cannot overwrite the winner's durable
schedule (`005_contract.md:780-811`).

Never call `withCodexWriteLock` from inside `withConfigMutationLockSync` or a
`mutatePersistedConfig` callback. Current inverse-edge search found config-owned
callbacks at `src/config.ts:1829,1870,2145`, the account wrapper at
`src/codex/account-store.ts:281`, and auth mutation at
`src/codex/auth-api.ts:670`; none currently imports the new lock. Add a dependency-
graph test that protects this direction. Source substring matching inside one file
is not enough.

## Shared helper deadline changes

`native-main-lock-file.ts` keeps ownership of stable descriptors. Add only an
optional stricter timeout for Windows hardening:

```diff
-export async function hardenStableLockFile(path: string): Promise<void> {
+export async function hardenStableLockFile(path: string, timeoutMs?: number): Promise<void> {
   try { chmodSync(path, 0o600); } catch {}
   if (process.platform === "win32") {
-    await hardenSecretPathAsync(path, { required: true, timeoutMemoKey: path });
+    await hardenSecretPathAsync(path, { required: true, timeoutMemoKey: path, timeoutMs });
   }
 }
```

`windows-secret-acl.ts` clamps the caller value to the existing configured budget;
it may shorten but never enlarge it. Existing callers that omit `timeoutMs` retain
current behavior. Required ACL failure still rejects.

## Test plan

`tests/helpers/codex-write-lock-child.ts` imports and calls the production API. It
accepts explicit test paths/timing through its environment, prints one typed result,
and never opens SQLite directly.

### Real-process identity and exclusion

1. Child holds home A; parent deadline returns typed busy and its callback does not
   run; a timer advances while waiting; parent later acquires after release.
2. Abrupt holder exit releases without unlink/stale recovery; live holder is never
   stolen across repeated deadlines.
3. Default/explicit/absolute/tilde/symlink/case-equivalent spellings of one existing
   home produce one ID; distinct homes acquire independently.
4. Missing homes refuse before namespace creation.

### Effective-user namespace activation — carried #7/C18

Run real pinned-Bun child processes, not pure resolver mocks:

1. Child A: `HOME=<fake-a>`, `USERPROFILE=<fake-common>`; hold the production lock.
2. Child B: `HOME=<fake-b>`, `USERPROFILE=<fake-common>`; same OS user and
   `CODEX_HOME`; assert busy on the **same** DB path/lock id.
3. Repeat with `HOME=<fake-common>` and independently different
   `USERPROFILE=<fake-a|fake-b>`.
4. On Windows, vary `USERPROFILE` while retaining the real account SID. On POSIX,
   vary both variables independently while retaining the real uid.
5. Assert exactly one namespace under the uid/SID component. A test that sets HOME
   and USERPROFILE to the same fake value in both children is insufficient because
   it cannot catch the original split.

Use `process.execPath` and assert the pinned Bun version expected by CI before the
probe. Do not substitute Node or a same-process environment mutation.

### Admission/config-record ordering

- Non-authorizing pre-snapshot leaves the runtime namespace absent.
- Under-lock authoritative snapshot mismatch calls no commit and writes no record.
- A cooperating config transition while gather is outside the lock prevents stale
  commit.
- A successful commit shows exact `nativeAfter` and this `txId`; another tx at the
  same numeric generation is interference.
- Inject config-lock contention; assert bounded retry/typed busy and no stale
  commit.
- Prove config/native generation and integration-record update occur inside the
  synchronous section by blocking a contender at each seam.

### Boundary/hardening

- Compile-time async callback rejection plus runtime thenable rejection and release.
- Callback throw releases then propagates.
- Namespace symlink/junction, wrong owner/mode, DB/journal substitution, WAL/SHM,
  malformed DB, ACL failure/timeout, unsupported filesystem all refuse without
  repair/deletion.
- Windows CI executes real SID/junction/ACL success; POSIX executes real uid/mode.
- Dependency graph proves no inverse C->N or C->H acquisition and no held N->H;
  history's only H->N edges are the fail-fast claim and terminal operations.

## Verification

```bash
bun test tests/codex-write-lock.test.ts --test-name-pattern "real two-process exclusion"
bun test tests/codex-write-lock.test.ts --test-name-pattern "HOME and USERPROFILE independently"
bun test tests/codex-write-lock.test.ts tests/windows-secret-acl.test.ts tests/native-main-claim.test.ts tests/native-main-owner-lifetime.test.ts tests/config-mutation-lock.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Run focused tests/typecheck on macOS, Linux, and Windows. No command starts, stops,
syncs, restores, or ensures the proxy; port 10100 is untouched.

## Deliberate residuals

- `realpath` does not collapse bind-mount/filesystem-namespace aliases. Unsupported
  network target classes are refused; arbitrary cross-namespace identity is not
  claimed.
- The caller chooses a finite automatic/explicit deadline within the API cap. WP11
  owns enforcement, not later policy values.
- Missing `CODEX_HOME` creation remains another operation/domain.
- Non-cooperating arbitrary filesystem ABA is outside the contract's proof bound.

## Accept criteria

- **C5** — finite async acquisition yields typed acquired/busy/refused behavior;
  callback is synchronous/bounded; no stale takeover or FIFO claim exists.
- **C6** — all real spellings of one existing home share one lock; distinct homes
  do not; missing homes refuse before artifacts.
- **C7/C18** — namespace keys on effective uid/SID beneath the OS runtime directory,
  never any home accessor. Real pinned-Bun children with independently varied HOME
  and USERPROFILE prove one lock for one user/home.
- Config generation, authoritative admission re-read, native/provenance writes,
  and the conditional transition-row update share N->C; C releases before N commits.
- `transition-state.ts` alone owns native generation/txId/history scheduling; JSON
  owns none of them, and WP11 never opens a second coordinator connection in C.
- Lock edges are N->C and short fail-fast H->N only; stale history jobs are rejected
  by generation/transaction identity without any C->N, C->H, or held N->H edge.
- **N2** — WP11 extends the already-working funnel and typechecks/preserves behavior
  at its own commit; WP12 strengthens admission without supplying missing mechanics.
