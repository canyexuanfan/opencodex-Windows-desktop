# WP8b — the shared surfaces, owned once

Audit round 1 (`006_audit_synthesis.md`) failed four ways on one cause: four
phase docs, written in parallel, each invented its share of a surface they all
touch. Round 2 (`007_audit_synthesis_r2.md`) failed because the first version of
this document **declared** ownership without **transferring** it — `020`, `030`
and `040` still carried their own record schema, their own route mapping and
their own module names, in roughly thirty places.

So this document is now the complete definition of every shared surface, and the
four phase docs are rewritten as consumers against the reviewer's section list.
A contract nobody collected is a fifth opinion.

## IN / OUT

IN: `src/codex/integration-record.ts` (NEW — sole owner of the record),
`src/codex/convergence.ts` (NEW — the single entry point),
`src/codex/convergence-types.ts` (NEW — every shared type),
`src/codex/generation.ts` (NEW), `src/codex/user-identity.ts` (NEW — §7),
`src/server/management/sync-response.ts` (NEW — the one adapter),
`tests/codex-integration-record.test.ts` (NEW),
`tests/codex-convergence-contract.test.ts` (NEW),
`tests/codex-user-identity.test.ts` (NEW).

OUT: catalog mechanics (WP9), history mechanics (WP10), lock mechanics (WP11),
ownership mechanics (WP12). This phase owns *shapes and the funnel*, not the
work inside them.

### What "lands first" has to mean (round 2 N2)

The reviewer showed the previous version could not land: it was "OUT: every
behavior" while declaring a runtime `convergeCodex`, and a throwing placeholder
is not a safe commit.

So WP8b lands **types, validators, the record owner, the identity resolver and
the response adapter — and rewires nothing.** `convergeCodex` is declared here
as a type only; WP9 supplies its first real implementation and rewires the
catalog callers at that commit.

**Invariant for every phase in this unit:** each phase typechecks and preserves
behavior at its own commit. No phase may leave a placeholder that a later phase
is required to replace before the tree is correct.

## 1. The record: one owner, one schema

`020` and `040` both wrote `integrations/codex.json` with a required `version: 1`
containing different fields, so a record from either is malformed to the other
(audit #3).

```ts
/**
 * The single durable record for the Codex integration.
 *
 * ONE owner. WP10 (history state) and WP12 (provenance) both write here, and
 * both go through `updateIntegrationRecord` — never their own read/merge/write.
 * Round 1 had two owners and two schemas for this exact file.
 *
 * Every section is OPTIONAL at v1. A record written before a section existed is
 * VALID, not malformed: absence means "that subsystem has not spoken yet". This
 * is what lets WP10 land before WP12 without a migration.
 */
export interface CodexIntegrationRecord {
  version: 1;
  history?: CodexHistoryState;
  provenance?: CodexProvenanceLedger;
  /** Bumped by every native commit. See §3. */
  generation?: number;
}
```

### The section types, defined HERE (round 2 #3)

The first version referenced `CodexHistoryState` and `CodexProvenanceLedger`
without defining them, so `020` and `040` kept their own. Both live in
`convergence-types.ts` and both phases import them:

```ts
export interface CodexHistoryState {
  status: "converged" | "pending" | "running" | "blocked" | "unknown";
  /** Why it is not converged, when it is not. */
  reason?: "db-busy" | "permission" | "worker-died" | "overtaken";
  attempts: number;
  /** null means "no timer armed"; see 020 — it must never mean "never again". */
  nextRetryAt: string | null;
  /** The transition this state belongs to, so an overtaken job is detectable. */
  txId: string | null;
  /** Unknown keys from a newer writer, preserved verbatim. */
  readonly [extra: string]: unknown;
}

export interface CodexProvenanceEntry {
  artifact: CodexArtifactId;
  baseline: { kind: "absent" } | { kind: "present"; sha256: string };
  /** Hash of what WE wrote. null when the write did not complete. */
  postImage: string | null;
  txId: string;
  at: string;
}

export interface CodexProvenanceLedger {
  entries: readonly CodexProvenanceEntry[];
  readonly [extra: string]: unknown;
}
```

`updateIntegrationRecord(mutate)` does one read-modify-write under the same
coordinator the config uses, and **preserves unknown keys verbatim at every
level** — top-level and inside each section — so a newer version's record
survives an older binary.

Unreadable or unparseable is not "empty": it fails closed and the caller reports
rather than silently starting a fresh record. Losing provenance silently is how
`005_disable_leaves_a_broken_file.md` became possible.

## 2. One convergence entry point

Audit #2: `010` rewires 16 management callers to a direct gather/commit helper,
and `040` never touches them, so a provider edit commits catalog bytes with no
ownership, provenance, intent or lock check. Today that helper is
`refreshCodexCatalogBestEffort` (`src/server/management-api.ts:105-112`) and its
entire error handling is `catch { /* catalog absent */ }`.

```ts
/**
 * The ONLY way Codex-owned bytes are written. Startup, ensure, /api/sync, the
 * CLI verbs and all 16 management mutation callbacks funnel here.
 *
 * The funnel is the point: admission, generation checks and the lock live in one
 * place, so a new caller cannot forget them. Round 1's 16 callers each held
 * their own path to a commit.
 */
export async function convergeCodex(request: ConvergeRequest): Promise<ConvergeOutcome>;

export interface ConvergeRequest {
  /**
   * The caller says WHEN, never WHICH WAY.
   *
   * Round 2 N1: an `apply | remove` request let `/api/sync` skip while desired
   * state was OFF instead of removing residue, which violates C11 and
   * contradicts the rule that callers cannot supply desired state. The
   * direction is derived from admitted persisted intent, full stop.
   *
   * `observe` writes nothing and is the status read.
   */
  action: "converge" | "observe";
  /** Why, for the record and for log attribution. */
  reason: "startup" | "ensure" | "api-sync" | "cli" | "management-mutation";
  /** Automatic callers fail fast and defer; explicit ones may wait. See §5. */
  mode: "automatic" | "explicit";
  deadlineMs: number;
}
```

`ConvergeOutcome` is a discriminated union, never a thrown exception for an
expected condition:

```ts
export type ConvergeOutcome =
  | { kind: "converged"; direction: "applied" | "removed"; changed: boolean;
      observed: CodexObservedState; generation: number;
      catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "skipped"; reason: "already-converged";
      observed: CodexObservedState; catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "refused"; authority: "service-home" | "external-provider" | "journal" | "provenance";
      message: string; observed: CodexObservedState }
  | { kind: "busy"; surface: "lock" | "history" | "config"; retryAfterMs: number }
  | { kind: "deferred"; direction: "applied" | "removed"; changed: boolean;
      unresolved: readonly UnresolvedSurface[];
      observed: CodexObservedState; catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "failed"; surface: string; message: string };

/**
 * Note what is NOT here: `desired-off`. Desired OFF is not a skip — it is a
 * `converged` with `direction: "removed"`. That is round 2 N1: the old shape let
 * a sync while OFF return "skipped" and leave routed residue on disk.
 */
export type UnresolvedSurface = "history";
```

**Best-effort callers stay best-effort.** The 16 management callbacks keep their
2xx and report the outcome in a `catalogRefresh` field; they do not start
failing loudly because a catalog refresh deferred. What changes is that the
outcome is *visible* instead of swallowed by a bare `catch`.

## 3. Generations: an expected transition, not a bare counter

Round 1 #5/#6 and round 2 N3. Three separate defects lived here.

`mutatePersistedConfig` documents its own limit (`src/config.ts:1855-1857`):

> A writer that ignores the coordinator can still change bytes after the final
> check because the filesystem has no portable conditional rename.

A content hash passes an A→B→A cycle. And my first counter was **bumped by every
native commit and compared before/after** — so a successful write always
mismatched. I specified a mechanism whose success condition was
indistinguishable from its failure condition.

### Two counters, not one

```ts
/** Bumped by every cooperating CONFIG write. Owned by src/config.ts. */
export interface ConfigGeneration { readonly value: number; }

/** Bumped by every cooperating NATIVE commit. Owned by convergence.ts. */
export interface NativeGeneration { readonly value: number; }
```

Round 2 #6: the previous version said "two counters, both in the record" and
then defined one. They are distinct because they answer different questions —
did the user's configuration move, versus did somebody else write Codex's files.

### The expected transition

```ts
export interface CommitExpectation {
  /** Read at admission. */
  readonly nativeBefore: number;
  /** What OUR commit will produce. Always nativeBefore + 1. */
  readonly nativeAfter: number;
  /** Identifies the commit that performed the bump. */
  readonly txId: string;
}
```

The rule, stated so a test can check it:

> After the commit, the record must show **exactly** `nativeAfter` AND `txId`
> equal to ours. `nativeAfter` with a different `txId` is another writer that
> raced us to the same number. Anything else is interference: the outcome is
> `deferred` with the surface named, never `converged`.

The bump is written **inside** the same synchronous section as the commit, by
the committer, so there is no window where the files moved and the counter did
not. On crash between file write and counter bump, the next convergence sees a
stale counter and re-converges — which is safe because convergence is idempotent
by construction.

### Prevention for cooperating writers (round 2 #5)

C2 says a stale candidate **cannot be committed**. Detect-after-commit permits
exactly the write C2 forbids, and `030` already allows the fix: the native lock
may hold the config mutation lock across the synchronous re-read and commit.

So:

| Writer | Mechanism |
|---|---|
| cooperating (ours) | **prevented** — config lock held through re-read and commit |
| non-cooperating (hand edit, foreign tool) | **detected** after the fact, reported `deferred` |

Re-gather is bounded by `deadlineMs`. On expiry the outcome is `deferred` with a
typed reason and another convergence is scheduled — the retry loop terminates on
a deadline, not on hope (round 1 #5's missing termination rule).

### Target identity, honestly bounded

A candidate records the canonical parent directory and the file identity
(dev+inode where available) of each target, not the textual path — a parent
symlink can retarget while the path string is unchanged, and `atomicWriteFile`
resolves the effective target only at commit (`src/config.ts:190-199`).

**What this does not do** (round 2 #6): it cannot detect a parent-symlink A→B→A
that happens entirely between two checks. C17 is therefore scoped to *cooperating
transitions and single-direction drift*, not to arbitrary filesystem ABA. Claiming
otherwise would be a promise the filesystem does not offer.

## 4. Admission returns a snapshot, not a boolean

Audit #8: `040`'s intent reader returns ON/OFF while `010`'s gather needs a full
`OcxConfig`, so either gather uses the stale server object or the claimed
"two reads" is wrong.

```ts
export interface AdmissionSnapshot {
  config: Readonly<OcxConfig>;
  configDigest: string;
  intent: "on" | "off";
  generation: number;
  ownership: "owned" | "foreign" | "unknown";
}
```

One read produces all of it. Gather consumes `config` — **that exact object**,
never a re-read and never the server's long-lived one. The under-lock recheck
compares `configDigest` and `generation` rather than reading the config again.

Read count per mutation: **one** before gather, **two** cheap counter reads
around the commit. `010`'s independent `readConfigDiagnostics()` call is removed.

## 5. `/api/sync`, defined once

Audit #4: three phases defined this route and the last one dropped `Retry-After`
and both payload fields.

| `ConvergeOutcome` | Status | Body |
|---|---|---|
| `converged` | 200 | `{ ok: true, changed, observed, catalogRefresh, history }` |
| `skipped` (`already-converged`) | 200 | `{ ok: true, changed: false, observed, catalogRefresh, history }` |
| `refused` | 409 | `{ ok: false, authority, message, observed }` |
| `busy` | 503 + `Retry-After` | `{ ok: false, surface, retryAfterMs }` |
| `deferred` | 200 | `{ ok: true, changed, unresolved, observed }` |
| `failed` | 500 | `{ error: message, surface }` |

`busy` is 503 with `Retry-After` because it is transient and the client should
retry; `refused` is 409 because retrying changes nothing until a human acts.
`deferred` is 200 because the requested work DID happen — history is outstanding
and named, not failed.

There is no `desired-off` row, per §2: a converge while OFF removes and returns
`converged { direction: "removed" }`.

**One adapter, one place.** `src/server/management/sync-response.ts` exports a
single exhaustive `toSyncResponse(outcome): Response`. `010`, `020` and `040`
each mapped this route themselves (round 1 #4, still open in round 2); none of
them may now. The exhaustiveness is enforced by a `never` check on the union, so
adding an outcome variant without a row fails typecheck.

## 6. History: one lock, and no overtaking

Round 1 #1 had no home; round 2 showed my first answer had two holes.

The real apply path writes manifest → rollouts → DB
(`history-provider.ts:606,611,626`); restore writes rollouts → DB → manifest
deletion → a second ejection (`:657,667,677,691`). SQLite guards only one of
those steps, so two processes corrupt each other through the files it never sees.

**One cross-process history lock**, acquired inside the Worker, held across the
entire unit — manifest, rollouts and the DB transaction together, including the
final post-probe. It is a sibling of the native lock, not nested, because the
native section must stay synchronous.

Two things round 2 caught:

**Explicit CLI history still ran inline** (`020:216-219,868-870`), outside any
lock. Every history caller takes this lock — server, CLI, startup, retry. A lock
one caller can skip is not a lock.

**Sibling locks permit overtaking.** A releases the native lock after committing
ON; B commits native OFF; B's history removal can then run before A's history
apply, leaving native OFF with history ON. So the history job carries the
`CommitExpectation` from §3:

> A history job whose `nativeBefore` no longer matches the record has been
> overtaken. It is **rejected before any mutation**, and the winning transition
> converges history itself. Overtaking is detected at the point of work, not
> raced at the point of scheduling.

That also bounds the livelock the reviewer raised: a rejected job does not retry
into the same race, it defers to the newer transition.

Ordering, so absence of deadlock is checkable: **native lock → history lock,
never the inverse**, and they are never held simultaneously.

## 7. The lock namespace keys on effective user, not on any home path

Round 1 #7 said `homedir()` reads `HOME`/`USERPROFILE`, so a service and a CLI
for the same user can take different locks. I accepted the fix — use
`os.userInfo().homedir` — and specified it.

The reviewer then **ran it on our pinned Bun 1.3.14**, and I reproduced the run:

```
HOME=/tmp/fakehome bun -e '...'
homedir:  /tmp/fakehome
userInfo: /tmp/fakehome
uid: 501   username: jun
```

Both home accessors return the fake environment path in this runtime. The
accepted fix does not work where we ship.

But the same probe shows the way out: **`uid` and `username` are real.** So the
coordination namespace keys on effective-user IDENTITY, never on a home path:

```ts
/**
 * Effective-user identity for the lock namespace.
 *
 * NOT a home path. Bun 1.3.14 returns an environment-controlled home from both
 * os.homedir() AND os.userInfo().homedir, so any home-derived namespace can be
 * split by a service and a CLI that see different HOME values — which defeats
 * exclusion entirely, silently.
 */
export type UserIdentity =
  | { platform: "posix"; uid: number }
  | { platform: "win32"; sid: string };
```

The lock path is then
`<os-runtime-dir>/opencodex/native-write-locks/v1/<uid-or-sid>/<sha256-of-canonical-CODEX_HOME>.sqlite`,
with the per-user directory created mode `0700` and validated by `lstat` before
use — a symlink or a wrong owner is a refusal, never a trust.

The test that matters, and the one my first version could not have failed: two
child processes with **different** `HOME`/`USERPROFILE` values must take the
**same** lock.

## 8. Names

Audit #13. Fixed here so no phase invents a variant:

| Thing | Module |
|---|---|
| the native write lock | `src/codex/codex-write-lock.ts` |
| the record | `src/codex/integration-record.ts` |
| the entry point | `src/codex/convergence.ts` |
| generations | `src/codex/generation.ts` |
| history worker | `src/codex/history-worker.ts` |

## 9. Baseline classes

Two, not three. A provenance baseline is `absent` or `present`, and `present`
carries the exact baseline bytes — which already expresses restoration for every
Codex artifact.

The `present-required-nonempty` class I added in the first version is **removed**
(round 2 #4). It came from the live Pi incident in
`005_disable_leaves_a_broken_file.md`, where a disable left `models.json` as `{}`
and violated Pi's required-`providers` schema. That is real, and it belongs to
`FOLLOWUP-FILECLIENT-01` with the rest of the six file clients — which this unit
lists as out of scope. It named no baseline bytes, no client schema and no
validator, because a Codex unit has nowhere to get them.

Housing a finding in the wrong unit is not housing it.

## Test plan

`tests/codex-integration-record.test.ts`: a v1 record with only `history` is
valid to a provenance reader and vice versa (audit #3); unknown top-level keys
survive a write; unparseable fails closed rather than resetting.

`tests/codex-convergence-contract.test.ts`: every `ConvergeOutcome` variant maps
to the §5 row, `busy` carries `Retry-After`, and a best-effort management caller
still returns 2xx while reporting a non-converged disposition.

**The funnel must be provable, not grepped** (round 2 #2). A grep guard misses a
wrapper in the same module, a re-export, an alias and a dynamic import — and the
tree has all four today: `refreshCodexModelCatalog` wraps the catalog writers
(`refresh.ts:40-52`), `restoreNativeCodex` wraps config/catalog/history removal
(`inject.ts:764-794`), and `catalog.ts:11` re-exports the direct writers.

So the low-level writers move into `src/codex/internal/` whose **only** permitted
importer is `convergence.ts`, and the guard test walks the module dependency
GRAPH — static imports, dynamic imports, re-exports and aliases — asserting no
other path reaches them. Reachability, not spelling.

## Accept criteria

- C14 — all 16 management callers funnel through `convergeCodex`, enforced by the
  import guard test.
- C16 — one owner, one schema; a record from any phase reads in every other.
- C17 — an A→B→A cycle between gather and commit is detected by generation, and
  a parent-symlink retarget is detected by target identity.
- Contributes to C15 (the history protocol is specified here, implemented in
  WP10) and to C2/C12 (generations and the admission snapshot).
