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

## Round 6 — three findings that came from running the code, not reading it

Rechecked on 2026-08-05 at `86e5d677b`, with executed probes rather than citation.
All three change what B must build.

### F1 — the coordinator refuses to open on every routed install (blocking)

`openCodexCoordinatorTransaction` initializes a missing row only after
`assertInitialStateCanBeCreated()` proves the record is not legacy and
`classifyNativeRoutedResidue()` returns `clean`
(`src/codex/transition-state.ts:263-303`). A routed `config.toml` — which is
exactly what every user with the proxy applied has — is residue. Executed against
a temp home containing a routed `model_provider = "opencodex"` block:

```text
REFUSED: CodexCoordinatorLegacyAmbiguousError
  | A missing coordinator row cannot be initialized while native Codex routing residue exists.
```

The same probe against a clean home opens and returns
`{"nativeBefore":0,"nativeAfter":1,...}`.

So the plan's instruction to "place WP9's fixed catalog/native commit under the new
lock" is, as written, a **regression for every existing routed installation**: a
catalog refresh that succeeds today would begin refusing. The compatibility-adoption
path that `005_contract.md:705-800` designed for this is **not implemented** —
`withCodexCompatibilityNativeHandoff` and `adoption-pending` have zero occurrences
in `src/`.

WP11 therefore ships the lock **without rewiring `convergence.ts` to require N**.
`commitCodexCatalogCandidate` keeps `K -> C` (`src/codex/convergence.ts:393-406`),
which is already correct and already cross-process safe. `convergence.ts` moves
under N in WP12, together with the admission pipeline and the adoption path that
makes opening N legal on a routed home. Landing the lock and its rewiring in one
phase would mean landing a refusal for the current user base to satisfy a document.

That is not a scope dodge: WP11's own accept criteria (C5/C6/C7/C18) are about
acquisition, identity, and namespace. None of them requires the catalog seam to be
the first caller. What WP11 must NOT do is ship a module with no caller — defect #10
in this unit was exactly that — so the deliverable includes the real
`convergeCodexNativeUnderLock` entry consumed by a production route, gated to the
homes where N can legally open, plus the falsifiable test that a routed home refuses
with a typed reason instead of throwing.

#### The direction asymmetry — real, but it does NOT supply a caller

"N cannot open" is not uniform, and the difference decides which production path
WP11 can legally serve. Probed both directions against real temp homes:

| Operation | Home state when N is taken | Result |
|---|---|---|
| **apply** (route Codex at the proxy) | clean — not yet routed | `OPEN OK`, expectation `{nativeBefore:0, nativeAfter:1}` |
| **restore** (unroute back to native) | already routed | `REFUSED` — legacy-ambiguous |

A first apply on an unrouted home is the one state the strict initializer accepts,
because the residue it refuses is the routing this operation has not performed yet.

**That is where I claimed a production caller, and review round 6 proved the claim
false.** The paragraph that stood here named `injectCodexConfig`
(`src/codex/inject.ts:487`) as a caller WP11 could serve. Three facts kill it:

1. Production reaches `injectCodexConfig` **directly** from `src/codex/sync.ts:58,110`
   and `src/cli/init.ts:197`. None of them goes through `convergence.ts`, which is
   the only module this phase's write scope was allowed to modify. Adding an entry
   point to `convergence.ts` therefore adds an export nothing calls.
2. `injectCodexConfig` cannot become the synchronous commit callback as it stands.
   It journals (`src/codex/inject.ts:530`), writes native files
   (`:601`), and then **awaits** the history job (`:614`). The synchronous native
   section has to be split from post-N history dispatch before any of it can sit
   under N.
3. There is no runtime producer of a full `AdmissionSnapshot` at all. It exists only
   as an interface (`src/codex/convergence-types.ts:495`); the sole thing production
   builds today is `CatalogAdmissionSnapshot`. WP11's own API requires the former.

So the narrowing as written *was* a dodge, and its own falsification test — "if the
apply path cannot legally take N either, fold WP11 into WP12" — has now fired. The
resolution is recorded below rather than argued away.

#### Resolution: WP11 MERGES INTO WP12. This document becomes WP12's lock section.

My first attempt at a resolution was "mechanism-only": ship the lock and its tests,
move the caller to WP12, and defend the boundary by analogy to WP8b, which also
shipped before it had a consumer. Round 7 rejected the analogy, correctly.

WP8b was a **contract** consumed by four later phases; publishing it first is what
stopped WP9-WP12 from inventing four incompatible shapes. WP11 has exactly **one**
planned consumer, and the two things needed to exercise its API — a production
`AdmissionSnapshot` producer and the apply/restore split in `inject.ts` — both arrive
in that same consumer. So a standalone WP11 can only prove that a **fabricated**
snapshot and a **fabricated** callback drive the primitive. It cannot prove the API
fits the one real caller it exists for. That is precisely the shape this unit keeps
producing: a green, unusable seam.

The surrounding documents already assume the merged shape and were never consistent
with a standalone WP11:

- `005_contract.md:635` assigns WP11 "that complete async N → K → C mechanism **and
  its broader caller rewire**".
- `040_ownership_convergence.md:15` states WP9-WP11 "already provide the working
  `convergeCodex` funnel ... and native lock" — a claim a mechanism-only WP11 makes
  false.
- `040_ownership_convergence.md:211` is where the actual call edge lives.

So the merge is not a concession, it is the reading that makes three documents agree.

**What this means concretely:**

- The N mechanism has **no independent completion gate**. It is audited together
  with its first production caller, or it is not audited.
- It may still land as its own commit for reviewability. A commit boundary is not a
  phase boundary.
- The goalplan work-phase is restructured accordingly: `wp11` is closed as *merged*,
  and `wp12` carries the mechanism, the admission producer, the `inject.ts`
  apply/restore split, and the first call edge as required tasks.
- **F4 is the exception and lands alone.** The ACL pathname-cache defect is a live
  bug in shipped code (`src/lib/windows-secret-acl.ts`), independent of the lock, and
  it has its own falsifiable test. It does not wait for WP12.

Everything below this line is therefore **WP12's lock section**, rewritten to the
decisions above. Where the historical text conflicts with them, the decisions win —
and the sections that conflicted have been rewritten rather than annotated, because
round 7's finding was exactly that corrective prose above a contradictory body is
instance #16 of treating an absence as a guarantee.

### F2 — the initializer's residue guard reads the AMBIENT home, not the locked one

Absence-as-guarantee #14. `classifyNativeRoutedResidue()` resolves its own home
through `getCodexHome()` (`src/codex/native-residue.ts:524`), which re-reads
`process.env.CODEX_HOME` (`src/codex/paths.ts:32-35`). `readIntegrationRecord()`
resolves its path the same ambient way. But `resolveCodexCoordinatorDatabasePath`
is keyed by the **caller-supplied canonical home**. Executed with ambient
`CODEX_HOME` pointing at a clean directory and the explicit target home routed:

```text
ambient CODEX_HOME = <tmp>/clean
explicit home      = <tmp>/routed
OPENED OK for a ROUTED explicit home -> residue check used the AMBIENT home
```

The guard passed by inspecting a directory that is not the one being locked. Every
existing caller happens to pass the ambient home, so the defect is latent today and
becomes live the moment WP11 accepts an explicit `codexHome` — which its API does.

Consequence for WP11: `CodexWriteLockOptions.codexHome` may not be forwarded to a
coordinator whose safety guard reads a different home. WP11 refuses with
`authority_not_proven` when the canonical target home is not identical to the
ambient `getCodexHome()` result, and a test drives the mismatch. Making the
guard home-parameterized is WP12's job (it owns admission); WP11 must not silently
accept a home whose residue was never checked.

**The obvious version of that remedy is itself a TOCTOU**, and it was caught by
probing rather than by reading. `getCodexHome()` re-resolves `process.env.CODEX_HOME`
on every call (`src/codex/paths.ts:32-35`), so two calls inside one operation can
return two different directories:

```text
same call, two answers: true | a -> b
```

A comparison that calls `getCodexHome()` once to validate and lets the coordinator
call it again to check residue proves nothing: the second read is a fresh read. So
the check is not "compare the two", it is **resolve the ambient home exactly once,
canonicalize it, use that single value for both the comparison and the lock target,
and refuse if the caller supplied anything else**. WP11 never re-reads the ambient
home after that point, and the residue guard's own later read is covered only
because it is bounded by N — a second process that changes the environment cannot
change ours, and our own code does not mutate `CODEX_HOME` mid-operation.

That last clause is a claim, not an assumption, so it needs a guard rather than a
comment: the B phase adds a test that fails if any production module under `src/`
assigns to `process.env.CODEX_HOME`. Today `rg -n "env.CODEX_HOME\s*=" src` finds
nothing, and an absence that nothing enforces is precisely the defect this unit has
now hit fourteen times.

**And the grep proves the claim false, which is why it was run.** Production code
does assign `process.env.CODEX_HOME`, in two places:

- `src/codex/history-worker.ts:158` — WP10 added this in THIS session. The Worker
  receives the parent's home in its run message and installs it before doing any
  history work.
- `src/storage/policy-worker.ts:34` — the same bootstrap shape, older.

Both are Worker entry bootstraps: they set the variable once, at thread start,
before that thread resolves any path, so neither mutates the home of a thread that
is mid-operation. That makes the invariant WP11 needs narrower and checkable:
**no assignment to `process.env.CODEX_HOME` outside a Worker bootstrap**, i.e. none
on a thread that could be holding N. The B-phase guard asserts exactly that, with
the two known bootstraps as named exceptions, so a third assignment added on a
request path fails the test instead of silently invalidating the once-resolved home.

Writing this down mattered more than the guard does. The paragraph above originally
asserted the grep was empty; running it produced two hits, one of them added by this
very session. That is instance #15 in miniature — the absence was asserted from
memory of the design instead of from the tree — and it is the reason every claim in
this phase gets executed rather than recalled.

#### Two more holes review found in this same remedy

The canonicalize-once rule above is necessary and still not sufficient.

**A symlinked default home refuses itself.** With no `CODEX_HOME` set,
`getCodexHome()` returns `defaultCodexHome()` **without** `realpath`
(`src/codex/paths.ts:23`), while WP11's target is `realpathSync.native`-canonical. On
a machine where `~` or `~/.codex` is a symlink, the two strings differ and the lock
refuses a home that is in fact the same directory. The comparison must canonicalize
**both** sides before comparing, never the target alone.

**The comparison must be adjacent to the open.** Acquisition retries across `await`
boundaries. A comparison performed before the retry loop and an
`openCodexCoordinatorTransaction` performed after it are separated by suspension
points, so the guard re-reads the environment in between. The canonical ambient home
is resolved once, and the equality check is re-asserted **immediately before** the
synchronous open with no `await` between them.

**And one citation in the original F2 text was simply wrong.** It said
`readIntegrationRecord()` resolves its path from the ambient CODEX_HOME. It does not:
its path comes from `getConfigDir()` (`src/codex/integration-record.ts:28`), which is
`OPENCODEX_HOME`, a different variable. Only `classifyNativeRoutedResidue()` reads
the ambient Codex home. The defect is real and the mechanism was misdescribed; the
narrower true statement is what B implements against.

### F4 — absence-as-guarantee #15: ACL success is cached by pathname, not identity

This one is a live defect in shipped code, not only in the plan.
`hardenStableLockFile` delegates to `hardenSecretPathAsync`
(`src/codex/native-main-lock-file.ts:127`), which returns success purely because the
**pathname** is in a module-level `Set<string>` (`src/lib/windows-secret-acl.ts:36,461`).
Nothing in that cache is bound to the file's identity. Review's executed probe
hardened a path, unlinked it, recreated it at the same name, and re-hardened:

```text
{"firstCalls":3,"totalCalls":3,"replacementWasRechecked":false}
```

The replacement file received **zero** ACL calls. The plan's "validate the DB, refuse
substitution" section inherits this: it treats "no path change observed" as proof
that the cached ACL still describes the current inode. It does not, and on Windows
that means a substituted coordinator database can be adopted with the previous
file's hardening credited to it.

Remedy for B: bind the ACL success cache to stable file identity, or invalidate the
entry when the stable descriptor's last reference closes so the next acquisition
revalidates. The regression test must be release → replace → **reacquire**;
substituting the file during a single held acquisition does not reach the cache and
would pass with the fix removed.

### F5 — deadline exhaustion must not be a permanent refusal

The result taxonomy carries `busy/deadline` as retryable, but the acquisition section
classifies ACL failure — including timeout — as a non-retryable refusal, and says only
SQLite busy retries. A caller-supplied short remaining deadline can time ACL work out
without proving anything unsafe; that is exhaustion, not unsafe authority. Worse, the
current ACL code rethrows a sanitized untyped `Error`
(`src/lib/windows-secret-acl.ts:484`), discarding the `ETIMEDOUT` discriminator the
classification would need.

B preserves a typed timeout discriminator through sanitization, maps outer-budget
exhaustion to `busy/deadline`, and reserves non-retryable refusal for verified
ACL/ownership/path failures.

### F6 — citation corrections

Verified accurate: `native-main-lock-file.ts:35-55,74-131`,
`native-main-owner.ts:75-91`, `home.ts:135-146`, `paths.ts:6-24`.

Corrected:

| Cited | Problem | Use instead |
|---|---|---|
| `src/config.ts:1853-1859` | those lines are config-generation reads, not the conditional-rename statement | `src/config.ts:1949` |
| `src/config.ts:1767-1818` | stops before callback execution, commit, rollback, and close | `src/config.ts:1779-1839` |
| `windows-secret-acl.ts:217-328,404-494` | misses `HardenOptions`/deadline clamping and the exported async entry | add `:45` and `:512` |

### The type block must not redeclare the capability

The public-contract fence below prints its own `unique symbol` brand and its own
`CodexCoordinatorTransaction`. Both already exist:
`src/codex/convergence-types.ts:331` owns the public interface and
`src/codex/transition-state.ts:148` owns the private brand. The fences compile in
isolation — which is exactly why the fence check did not catch this — but an
integration compile assigning `openCodexCoordinatorTransaction(...).capability` to
the plan's local type fails:

```text
TS2741: Property '[codexCoordinatorTransactionBrand]' is missing in type
'convergence-types.CodexCoordinatorTransaction'
but required in type 'plan.CodexCoordinatorTransaction'.
```

The implementation **imports** `CodexCoordinatorTransaction` from
`./convergence-types` and declares no local brand. The fence below is retained as the
historical shape; where it declares the brand and interface, read the import.

### F3 — `journal_mode` and reentrancy needed no new mechanism

A pinned-Bun probe shows `bun:sqlite` opens in `delete` mode by default and leaves
no `-wal`/`-shm` sidecar after a committed `BEGIN IMMEDIATE`, so the plan's
"forces rollback journal mode" is a verification, not a conversion. And a second
`openCodexCoordinatorTransaction` on a held path in the SAME process already fails
with `SQLiteError: database is locked`, because `busy_timeout = 0` is set before
`BEGIN IMMEDIATE` (`src/codex/transition-state.ts:416`).

`AsyncLocalStorage` reentrancy detection therefore is not what prevents a
same-process deadlock — SQLite already does. It exists to turn an
indistinguishable `busy` into a typed `refused/reentrant`, which is a diagnosis
improvement, not an exclusion mechanism. The test must assert the typed reason,
not "does not hang", or it proves nothing SQLite was not already doing.

## IN / OUT

IN:

- `src/codex/codex-write-lock.ts` (NEW) — exact contract module name; canonical
  target identity, effective-user namespace, finite async acquisition, synchronous
  coordinated commit, release, and typed lock mechanics.
- `src/codex/convergence.ts` (MODIFY) — add the native convergence entry that takes
  N and publishes a transition, called by the WP12 admission pipeline. It does NOT
  move the **existing catalog commit** under N: that seam keeps its current `K -> C`
  (`src/codex/convergence.ts:393-406`), because N refuses to open on a routed home
  and rewiring it would break every applied install (F1).
- `src/codex/inject.ts` (MODIFY) — split the synchronous native mutation from the
  awaited history dispatch (`:530` journal, `:601` native writes, `:614` awaited
  history) so the native section can sit beneath N and history stays outside it.
- The WP12 admission producer (MODIFY/NEW per `040_ownership_convergence.md`) —
  without it there is no `AdmissionSnapshot` at runtime and the lock's API cannot be
  called at all. `AdmissionSnapshot` is today only an interface
  (`src/codex/convergence-types.ts:495`).
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
  CodexCoordinatorTransaction,
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

// NO local brand and NO local interface here. `CodexCoordinatorTransaction` is
// imported above from `./convergence-types` (`src/codex/convergence-types.ts:331`);
// its private brand belongs to `src/codex/transition-state.ts:148` and to nothing
// else. Redeclaring either compiles fine in isolation — which is why the per-document
// fence check did not catch it for several rounds — and then fails at the only place
// that matters, assigning a real `openCodexCoordinatorTransaction(...).capability`:
//
//   TS2741: Property '[codexCoordinatorTransactionBrand]' is missing in type
//   'convergence-types.CodexCoordinatorTransaction' but required in type
//   'plan.CodexCoordinatorTransaction'.

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
callback — **imported**, not redeclared, from `./convergence-types`. It is branded by
`transition-state.ts` alone and exposes only the contract's null-safe conditional
transition-row update. It is one-shot for this transition, and the lock verifies that
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
for the current synchronous stack (`src/config.ts:1779-1839`, which includes the
callback execution, commit, rollback, and close the shorter range cut off). The
native lock may
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
§3; this phase does not promise a portable conditional rename that
`src/config.ts:1949` explicitly says the filesystem lacks.

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
  (`src/lib/windows-secret-acl.ts:45,217-328,404-494,512`). A **verified** ACL,
  ownership, or path failure refuses. **Timeout does not**: exhausting the outer
  budget is `busy/deadline` and retryable, because a short caller-supplied deadline
  proves nothing about safety (F5). That requires preserving the `ETIMEDOUT`
  discriminator through sanitization at `src/lib/windows-secret-acl.ts:484`, which
  today rethrows an untyped `Error` and destroys it.
- The ACL success memo must be bound to **file identity**, not pathname. Today it is
  a `Set<string>` of paths (`src/lib/windows-secret-acl.ts:36,461`), so a file
  replaced at the same name inherits the previous file's hardening — probed as
  `{identityChanged:true, firstCalls:3, totalCalls:3, replacementWasRechecked:false}`
  (F4). Ephemeral temps already invalidate through `forgetEphemeralSecretPath`
  (`src/config.ts:214,241,309,336,480,501-510`); the stable destination memo that
  `hardenStableLockFile` uses never does.
- Existing DB or `-journal` must be regular, same-user private entries. Existing
  `-wal`/`-shm` refuses. The lock **verifies** rollback journal mode rather than
  forcing it: a pinned-Bun probe shows `bun:sqlite` already opens `delete` and leaves
  no `-wal`/`-shm` sidecar after a committed `BEGIN IMMEDIATE` (F3).
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
`BEGIN IMMEDIATE`. **Two** conditions retry: SQLite busy/locked, and exhaustion of
the outer budget during Windows ACL work, which is `busy/deadline` (F5). Verified
filesystem, ACL, malformed DB, identity, permission, and journal-mode failures are
refusals. The distinction is not cosmetic: a refusal tells the caller never to try
again, and a short deadline is not evidence of an unsafe namespace.

Retry sleeps are async uniformly bounded 25-75 ms, clipped to remaining deadline,
and abortable. Barging is allowed; no caller/test infers FIFO. Candidate SQLite and
side descriptors close after every failed attempt.

`AsyncLocalStorage<ReadonlySet<string>>` rejects same-task same-home reentrancy. It
is a **diagnosis** layer, not the exclusion mechanism: a second open on a held path
in the same process already fails `SQLITE_BUSY`, because `busy_timeout = 0` precedes
`BEGIN IMMEDIATE` (`src/codex/transition-state.ts:416`). Its only job is to turn that
indistinguishable `busy` into a typed `refused/reentrant` (F3), so its test asserts
the typed reason and not "does not hang" — the latter passes with ALS deleted.
A separate task is an ordinary contender. Caller exceptions propagate after
rollback/release; they are never converted to busy/refused.

**The ambient-home re-assert sits here, in the acquisition loop, not before it.**
Every attempt performs, in one uninterrupted synchronous stack:

```text
canonicalAmbient = realpathSync.native(getCodexHome())
require canonicalAmbient === canonicalTarget      // both sides canonicalized
openCodexCoordinatorTransaction(finalDatabasePath) // no await, no callback between
```

Re-comparing the value captured before the retry sleeps proves nothing, because
`getCodexHome()` re-reads the environment on every call (`src/codex/paths.ts:32-35`)
and the coordinator's own residue guard reads it again inside the open. Only a fresh
read that shares a synchronous stack with the open denies another task the chance to
interleave. "N bounds it" is false and was struck: N serializes the coordinator
database, not `process.env`, and it is not even held until the open begins.

Canonicalizing **both** sides is required, not tidiness. With no `CODEX_HOME` set,
`getCodexHome()` returns `defaultCodexHome()` **without** `realpath`
(`src/codex/paths.ts:23`), so on a machine where `~/.codex` is a symlink an
uncanonicalized ambient value refuses the very home it names.

The real fix is to parameterize `classifyNativeRoutedResidue()` with the canonical
target and remove ambient authority from the guard entirely. The adjacency rule above
is the bounded version that survives until that lands, and the merged WP12 phase
carries the parameterization as a task.

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
  malformed DB, **verified** ACL failure, and unsupported filesystem all refuse
  without repair/deletion. ACL **timeout** is `busy/deadline`, not refusal (F5).
- **Release → replace → reacquire** (F4): harden a coordinator DB, release the
  acquisition, unlink and recreate a different file at the same pathname, then
  reacquire and assert the replacement was re-hardened. Substituting the file while
  a single acquisition is still held does NOT exercise the memo and passes with the
  fix removed — that shape is explicitly insufficient.
- Environment mutation **during** acquisition retry, not merely before it: a home
  changed while the contender sleeps must be caught by the fresh adjacent read.
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

Every criterion below names the **mutation that must turn it red**. A criterion with
no such mutation is not a criterion; this unit has shipped five live defects beside
8000 passing tests, so "the suite is green" carries no weight here. Each one was
checked against the question *would this still pass with the mechanism removed?* —
and the ones that did were rewritten rather than kept.

- **C5** — finite async acquisition yields typed acquired/busy/refused behavior;
  callback is synchronous/bounded; no stale takeover or FIFO claim exists.
  *Red when:* N acquisition is replaced by direct callback execution — the real
  two-process exclusion test must fail.
- **C6** — all real spellings of one existing home share one lock; distinct homes
  do not; missing homes refuse before artifacts.
  *Red when:* the canonicalization step is dropped — symlink and tilde spellings
  must stop contending.
- **C7/C18** — namespace keys on effective uid/SID beneath the OS runtime directory,
  never any home accessor. Real pinned-Bun children with independently varied HOME
  and USERPROFILE prove one lock for one user/home.
  *Red when:* the uid/SID component is replaced by any home accessor — the two
  children must stop sharing one lock.
- Config generation, authoritative admission re-read, native/provenance writes,
  and the conditional transition-row update share N->C; C releases before N commits.
  *Red when:* the apply/restore → N call edge is removed — the production-path test
  must fail. This criterion is unmeetable without the WP12 caller, which is exactly
  why the phases are merged.
- **F1** — a routed CODEX_HOME returns a typed refusal carrying the coordinator's
  legacy-ambiguous reason rather than throwing, **and** the existing catalog commit
  still succeeds on that same routed home.
  *Red when:* the catalog commit is moved under N — the routed-home catalog test
  must fail. That is the regression this finding exists to prevent.
- **F2** — the successful matched-home path reaches `BEGIN IMMEDIATE`, and a home
  changed **during acquisition retry** is caught.
  *Red when:* the fresh adjacent ambient read is replaced by the value captured
  before the retry sleeps — the environment-change-during-retry test must fail. A
  test that only exercises mismatched-home refusal is insufficient: it passes even
  if the matched path never acquires anything.
- **F3** — same-process reentrancy returns `refused/reentrant`, distinguishable from
  the `busy` SQLite alone produces.
  *Red when:* ALS is removed — the reason must degrade to `busy`. Asserting only
  "does not hang" is vacuous, because `busy_timeout = 0` already guarantees that.
- **F4** — a coordinator database released, replaced at the same pathname, and
  reacquired is re-hardened.
  *Red when:* identity binding / memo invalidation is removed — the
  release → replace → **reacquire** test must fail. Substituting during a single
  held acquisition never reaches the memo and would pass with the fix gone.
- **F5** — outer-budget exhaustion during ACL work returns retryable
  `busy/deadline`; verified ACL/ownership/path failure returns non-retryable refusal.
  *Red when:* `ETIMEDOUT` is collapsed into a generic refusal — the deadline
  classification test must fail.
- `transition-state.ts` alone owns native generation/txId/history scheduling; JSON
  owns none of them, and the lock never opens a second coordinator connection in C.
- Lock edges are N->C and short fail-fast H->N only; stale history jobs are rejected
  by generation/transaction identity without any C->N, C->H, or held N->H edge.
- **Phase honesty** — the goalplan records the merge: `wp11` closed as *merged*, and
  `wp12` carrying the mechanism, the admission producer, the `inject.ts` split, and
  the first call edge as required tasks. If the caller does not land, the PR body
  says the lock is unused, in those words.
  *Red when:* the WP12 admission producer is removed — the production-entry test or
  the compile must fail.
