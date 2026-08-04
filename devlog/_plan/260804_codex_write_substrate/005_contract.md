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
  /** Bumped by every cooperating native commit. See §3. */
  nativeGeneration?: number;
  /** The transaction that owns `nativeGeneration`; null is legal only at zero. */
  currentTxId?: string | null;
}
```

### The section types, defined HERE (round 2 #3)

The first version referenced `CodexHistoryState` and `CodexProvenanceLedger`
without defining them, so `020` and `040` kept their own. Both live in
`convergence-types.ts` and both phases import them:

```ts
export interface CodexHistoryState {
  status: "converged" | "pending" | "running" | "blocked" | "unknown" | "not-evaluated";
  /**
   * Why it is not converged, when it is not. These are terminal observations
   * for one attempt, not reasons to collapse the durable retry schedule.
   */
  reason?:
    | "db-busy"
    | "permission"
    | "unreadable"
    | "schema"
    | "timeout"
    | "shutdown-cancelled"
    | "worker-died"
    | "overtaken"
    | "record-write-failed";
  attempts: number;
  /** null means "no timer armed"; see 020 — it must never mean "never again". */
  nextRetryAt: string | null;
  /** The transition this state belongs to, so an overtaken job is detectable. */
  txId: string | null;
  /** null means the final probe could not produce a trustworthy row count. */
  pendingRows: number | null;
  /** null means the final probe could not produce a trustworthy manifest count. */
  backupEntries: number | null;
  /** Unknown keys from a newer writer, preserved verbatim. */
  readonly [extra: string]: unknown;
}

/**
 * Every mutable Codex artifact for which the provenance ledger can authorize a
 * restore. Embedded config fragments share the `config` entry because they are
 * committed and restored as one file. Dynamic history ids name the exact row or
 * rollout whose semantic pre-image is retained.
 */
export type CodexArtifactId =
  | { readonly kind: "config" }
  | { readonly kind: "generated-profile" }
  | { readonly kind: "active-catalog"; readonly canonicalPath: string }
  | { readonly kind: "catalog-backup"; readonly form: "hashed" | "legacy";
      readonly canonicalPath: string }
  | { readonly kind: "models-cache" }
  | { readonly kind: "injection-journal" }
  | { readonly kind: "history-row"; readonly stateDbId: string; readonly threadId: string }
  | { readonly kind: "history-manifest"; readonly stateDbId: string;
      readonly canonicalPath: string }
  | { readonly kind: "history-manifest-entry"; readonly stateDbId: string;
      readonly threadId: string }
  | { readonly kind: "history-rollout"; readonly stateDbId: string;
      readonly canonicalPath: string };

export interface CodexProvenanceEntry {
  artifact: CodexArtifactId;
  baseline:
    | { kind: "absent" }
    | { kind: "present"; sha256: string; bytesBase64: string };
  /** Hash of what WE wrote. null when the write did not complete. */
  postImage: string | null;
  txId: string;
  at: string;
}

export interface CodexProvenanceLedger {
  entries: readonly CodexProvenanceEntry[];
  readonly [extra: string]: unknown;
}

export type CodexArtifactObservation =
  | "applied"
  | "absent"
  | "missing"
  | "residue"
  | "drifted"
  | "unreadable"
  | "invalid"
  | "not-evaluated"
  | "unknown";

/**
 * Read-only proof of what Codex has now, not what persisted intent requests.
 * `isApplied` is true only for aggregate `applied`; a partial surface can never
 * be flattened into true. OFF is operationally converged only at `absent`.
 */
export interface CodexObservedState {
  aggregate: "applied" | "absent" | "partial" | "external" | "blocked" | "not-evaluated";
  /** null only for a catalog-scoped request that deliberately did not observe. */
  isApplied: boolean | null;
  desired: "on" | "off" | "unknown";
  /** null only when aggregate is `not-evaluated`. */
  converged: boolean | null;
  authority: {
    service: "owned" | "foreign" | "unknown";
    externalProvider: string | null;
  };
  surfaces: {
    config: CodexArtifactObservation;
    profile: CodexArtifactObservation;
    catalog: CodexArtifactObservation;
    cache: CodexArtifactObservation;
    journal: "absent" | "pending" | "live" | "invalid" | "unknown" | "not-evaluated";
    history: {
      state: CodexHistoryState;
      database: CodexArtifactObservation;
      manifest: CodexArtifactObservation;
      rollouts: CodexArtifactObservation;
    };
    provenance: {
      state: "verified" | "missing" | "conflict" | "unreadable" | "unknown" | "not-evaluated";
      nativeGeneration: number | null;
      currentTxId: string | null;
    };
  };
}

export type CatalogNotice = "provider-auth" | "provider-network" | "fallback";

/** Sanitized catalog fact safe to append to management mutation responses. */
export type CatalogDisposition =
  | { status: "committed"; changed: boolean; degraded: boolean;
      notices: readonly CatalogNotice[] }
  | { status: "skipped";
      reason: "not-requested" | "catalog-unavailable" | "busy" | "stale" | "refused";
      retryable: boolean }
  | { status: "failed"; reason: "provider-auth" | "provider-network" | "disk";
      phase: "gather" | "commit"; retryable: boolean; partialWrite: boolean };
```

`CatalogDisposition` contains no provider name, URL, token text, path, digest or
raw exception. `CodexObservedState.aggregate` follows the five-state projection
already derived from the real config/profile/catalog/cache/journal/history surfaces
(`devlog/_plan/260804_codex_write_substrate/004_ownership_and_convergence.md:235-273`);
its nested observations keep the
one-artifact partial cases testable instead of hiding them behind that aggregate.
For a clean history convergence, `reason` is absent and both probe counts are zero.
An unreadable DB/manifest uses `unreadable`; a readable but unsupported table or
manifest shape uses `schema`; a watchdog uses `timeout`; graceful drain uses
`shutdown-cancelled`; and failure of the terminal CAS uses
`record-write-failed` in the returned observation while leaving the previously
persisted `pending` schedule intact. Any failed/unavailable final probe stores null,
never a zero-looking count.
`not-evaluated` is an ephemeral projection used only by WP9's catalog-scoped
compatibility outcome; it is never persisted as durable history and never answers
`isApplied` or `converged` with a false-looking boolean.

### Durable read/update and initialization

```ts
export interface IntegrationRecordVersion {
  readonly nativeGeneration: number;
  readonly currentTxId: string | null;
}

export type IntegrationRecordRead =
  | { kind: "missing"; record: null; version: { nativeGeneration: 0; currentTxId: null } }
  | { kind: "ready"; record: CodexIntegrationRecord; version: IntegrationRecordVersion }
  | { kind: "legacy-ambiguous"; record: CodexIntegrationRecord }
  | { kind: "invalid"; message: string };

export type ReadIntegrationRecord = () => IntegrationRecordRead;

export type IntegrationRecordUpdate =
  | { kind: "updated"; record: CodexIntegrationRecord; version: IntegrationRecordVersion }
  | { kind: "conflict"; current: IntegrationRecordVersion }
  | { kind: "invalid"; message: string };

/**
 * Compare `expected` against both native fields, apply `mutate`, and atomically
 * replace the record while the caller's coordinator is held. A mismatch writes
 * nothing. The updater preserves unknown keys at every object level.
 */
export type UpdateIntegrationRecord = (
  expected: IntegrationRecordVersion,
  mutate: (record: CodexIntegrationRecord) => CodexIntegrationRecord,
) => IntegrationRecordUpdate;
```

WP8b implements and exports `const readIntegrationRecord: ReadIntegrationRecord`
and `const updateIntegrationRecord: UpdateIntegrationRecord` from
`src/codex/integration-record.ts`; these are executable functions in that phase,
not ambient declarations.

A missing file normalizes to `{ nativeGeneration: 0, currentTxId: null }`; the
first successful update creates `version:1` and persists both native fields even
when it writes only `history` or `provenance`. A v1 record with neither native field
has the same initial meaning, which keeps the history-only/provenance-only landing
order valid. A positive generation without a nonblank `currentTxId`, a txId without
its generation, `generation` from the abandoned draft schema, or `null` paired with
a nonzero generation is `legacy-ambiguous`: automatic mutation fails closed and an
explicit observation/recovery must establish a current pair. It is never silently
coerced to the initial state.

`updateIntegrationRecord` does one read-modify-write under the caller's coordinator.
Native transition N uses expected `{N,currentTxId}` and writes `{N+1,newTxId}`;
history/provenance completion uses the exact current pair it started from. Thus a
late Worker receives `conflict` rather than overwriting a competing txId at the same
number. Unknown keys survive top-level and section updates so a newer writer's
record survives an older binary.

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
export type ConvergeCodex = (
  request: ConvergeRequest,
) => Promise<ConvergeOutcome>;

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
  /**
   * WP9 management mutations use `catalog`; explicit/lifecycle convergence uses
   * `full`. Scope limits work, but still never lets the caller choose direction.
   */
  scope: "catalog" | "full";
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
  | { kind: "catalog-only"; changed: boolean;
      observed: CodexObservedState; catalogRefresh: CatalogDisposition;
      history: CodexHistoryState }
  | { kind: "converged"; direction: "applied" | "removed"; changed: boolean;
      observed: CodexObservedState; nativeGeneration: number;
      currentTxId: string;
      catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "skipped"; reason: "already-converged";
      observed: CodexObservedState; catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "refused"; authority: "service-home" | "external-provider" | "journal" | "provenance";
      message: string; observed: CodexObservedState }
  | { kind: "busy"; surface: "lock" | "history" | "config"; retryAfterMs: number }
  | { kind: "deferred"; direction: "applied" | "removed"; changed: boolean;
      unresolved: readonly UnresolvedSurface[];
      nativeGeneration: number; currentTxId: string;
      observed: CodexObservedState; catalogRefresh: CatalogDisposition; history: CodexHistoryState }
  | { kind: "failed"; surface: string; message: string };

/**
 * Note what is NOT here: `desired-off`. Desired OFF is not a skip — it is a
 * `converged` with `direction: "removed"`. That is round 2 N1: the old shape let
 * a sync while OFF return "skipped" and leave routed residue on disk.
 */
export type UnresolvedSurface =
  | "config"
  | "native"
  | "catalog"
  | "cache"
  | "journal"
  | "provenance"
  | "history";
```

This is deliberately a type alias, not the bodyless function declaration that
produced TS2391 in audit round 3. WP8b exports the type and lands no runtime
placeholder. WP9 supplies the first `convergeCodex` implementation and assigns it
to `ConvergeCodex` in the same commit that rewires catalog callers.

WP9's `scope:"catalog"` implementation is **catalog-only**: it gathers,
commits, and reports catalog/cache/backup disposition while preserving each route's
primary 2xx/201. It does not inject config/profile, recover journals, or dispatch
history before WP10-WP12 land those mechanisms. WP12 strengthens that same funnel
to full observed-state convergence; there is no second entry point.
Its `catalog-only` outcome sets non-catalog observations to `not-evaluated` and uses
an ephemeral history value with `status:"not-evaluated"`, zero attempts, null txId,
timer, and probe counts. It does not claim either full direction.

An unresolved surface also names its scheduler. `config` schedules a fresh
pre-gather admission; `native`, `catalog`, `cache`, `journal`, and `provenance`
schedule a full convergence for the record's current transaction; `history`
schedules the history guardian for that transaction. A scheduling write itself is
part of the durable record update, not a best-effort callback after the response.

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

The earlier “there is no window” claim was wrong. Process exclusion cannot make
separate file replacements and the integration-record replacement atomic. Holding
native + config coordination provides **no cooperating interleaving while the
process is alive**; a crash can still leave any prefix of the artifact sequence with
the old record pair.

Recovery is therefore artifact-specific. Config, generated profile, catalog,
hashed/legacy backups, cache, and journal recover only from their ledger baseline
plus matching post-image; a missing/null post-image preserves and refuses. History
rows, manifest entries, and rollouts remain `pending` and are re-probed/repaired by
the history guardian. A missing record with native residue or an invalid/ambiguous
record refuses automatic deletion. On restart, observation compares every artifact
to the ledger/current pair, records the unresolved surfaces, and schedules a fresh
current transition; idempotence is required but is not described as filesystem
atomicity.

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
/** The minimal, working WP8b/WP9 snapshot; it authorizes catalog work only. */
export interface CatalogAdmissionSnapshot {
  config: Readonly<OcxConfig>;
  generation: number;
  targets: Readonly<{
    catalog: string;
    cache: string;
    catalogBackups: readonly string[];
  }>;
}

export interface AdmissionSnapshot {
  config: Readonly<OcxConfig>;
  configDigest: string;
  intent: "on" | "off";
  generation: number;
  ownership: "owned" | "foreign" | "unknown";
  externalProvider: string | null;
  canonicalTargets: Readonly<{
    codexHome: string;
    opencodexHome: string;
    config: string;
    profile: string;
    catalog: string;
    cache: string;
    journal: string;
    integrationRecord: string;
    catalogBackups: readonly string[];
    historyDb: string;
    historyManifest: string;
    historyRollouts: readonly string[];
  }>;
  journalIdentity: string;
  provenanceIdentity: string;
  /** Digest of every authority field above; passed to the history Worker. */
  authoritySnapshotId: string;
}
```

The earlier one-read claim is withdrawn. There are three authoritative observation
points, each with a different job:

1. **Pre-gather:** fully read persisted config and all authority/target fields into
   snapshot A. Gather consumes `A.config` — that exact object, never the server's
   long-lived one.
2. **Under-lock:** while native + config coordination is held, fully re-read snapshot
   B and compare digest, config generation, intent, ownership, external provider,
   canonical targets, journal identity, and provenance identity. A mismatch rejects
   before the first native write.
3. **Post-commit:** re-read persisted config and observe every native/catalog/history
   surface into `CodexObservedState`. The outcome is not `converged` unless this
   observation agrees with admitted intent and the exact expected native pair.

The config reader at all three points is the persisted diagnostic reader. A missing,
unreadable, or invalid file produces unknown/refusal; it never falls back to the
server's captured object. `010`'s independent gather-time
`readConfigDiagnostics()` remains removed because snapshot A already owns that read.

## 5. `/api/sync`, defined once

Audit #4: three phases defined this route and the last one dropped `Retry-After`
and both payload fields.

| `ConvergeOutcome` | Status | Body |
|---|---|---|
| `catalog-only` | 200 | `{ ok: true, changed, observed, catalogRefresh, history }` |
| `converged` | 200 | `{ ok: true, changed, observed, catalogRefresh, history }` |
| `skipped` (`already-converged`) | 200 | `{ ok: true, changed: false, observed, catalogRefresh, history }` |
| `refused` | 409 | `{ ok: false, authority, message, observed }` |
| `busy` | 503 + `Retry-After` | `{ ok: false, surface, retryAfterMs }` |
| `deferred` | 200 | `{ ok: true, changed, unresolved, observed, catalogRefresh, history }` |
| `failed` | 500 | `{ error: message, surface }` |

`busy` is 503 with `Retry-After` because it is transient and the client should
retry; `refused` is 409 because retrying changes nothing until a human acts.
`deferred` is 200 because the admitted bounded work DID happen — one or more
durably scheduled surfaces are outstanding and named, not collapsed into success.

There is no `desired-off` row, per §2: a converge while OFF removes and returns
`converged { direction: "removed" }`.

**One adapter, one place.** `src/server/management/sync-response.ts` exports a
single exhaustive `toSyncResponse(outcome): Response`. `010`, `020` and `040`
each mapped this route themselves (round 1 #4, still open in round 2); none of
them may now. The exhaustiveness is enforced by a `never` check on the union, so
adding an outcome variant without a row fails typecheck.

## 6. History: one lock, with overtaking detected and repaired

Round 1 #1 had no home; round 2 showed my first answer had two holes.

The real apply path writes manifest → rollouts → DB
(`src/codex/history-provider.ts:606,611,626`); restore writes rollouts → DB →
manifest deletion → a second ejection
(`src/codex/history-provider.ts:657,667,677,691`). SQLite guards only one of those
steps, so two processes corrupt each other through the files it never sees.

**One cross-process history lock**, acquired inside the Worker, held across the
entire unit — manifest, rollouts and the DB transaction together, including the
final post-probe. It is a sibling of the native lock, not nested, because the
native section must stay synchronous.

Two things round 2 caught:

**Explicit CLI history still runs inline** through direct sync/restore calls
(`src/cli/index.ts:528,591,756,768,829`), outside any future history lock. Every
history caller takes this lock — server, CLI, startup, retry. A lock one caller can
skip is not a lock.

**Sibling locks permit overtaking.** A releases the native lock after committing
ON; B commits native OFF while A traverses history. Checking once after A acquires
the history lock only moves the race: B can still advance the native pair before A
finishes. The previous check against `nativeBefore` was also the wrong side. After
A's native commit, the record is expected to contain A's
`{ nativeAfter, txId }`, not `nativeBefore`.

This contract chooses **detect-and-repair**, not a transition gate shared across
the complete history unit. The guarantee is eventual convergence to the latest
durable native transition:

1. The native record CAS that writes `{nativeAfter, txId}` also writes
   `history:{status:"pending", txId, nextRetryAt:<due>, ...}` for that same
   transition **before** any Worker spawn. If spawn never occurs or the Worker dies,
   the guardian/startup reader still has durable work to schedule.
2. A Worker checks that the record contains its `{nativeAfter, txId}` immediately
   after acquiring the history lock. A mismatch returns `pending/overtaken` without
   mutation and schedules observation of the current pair.
3. Because a newer native transition can commit during traversal, the Worker uses
   `updateIntegrationRecord({nativeGeneration:nativeAfter,currentTxId:txId}, ...)`
   for its terminal state. A CAS conflict means its result is stale; it does not
   overwrite the newer transition's pending schedule and returns `overtaken`.
4. If an old Worker mutated history before detecting that final conflict, the newest
   transition remains durably pending and runs after the old Worker releases the
   history lock. Therefore stale history may exist temporarily, but it cannot become
   the terminal recorded state or cancel repair of the winner.

This is narrower than prevention. No test or caller may claim an old Worker cannot
write after a newer native commit; the testable claim is that the latest pair stays
durably scheduled and eventually owns the clean under-lock post-probe, even across
spawn failure, Worker death, or process restart.

Ordering, so absence of deadlock is checkable: **native lock → history lock,
never the inverse**, and they are never held simultaneously.

## 7. The lock namespace has one environment-independent root per effective user

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

The key alone was not enough. The earlier `<os-runtime-dir>` called an undefined
resolver and allowed service/CLI processes to choose different parents through
`TMPDIR`, `XDG_RUNTIME_DIR`, or `LOCALAPPDATA`. `resolveOsRuntimeDirectory` is now
the sole algorithm below and reads none of those variables.

```ts
/**
 * Resolve the effective account from operating-system identity APIs only.
 * Failure is a typed namespace refusal; username/home/environment fallback is
 * forbidden because it can split one account across two lock databases.
 */
export type ResolveEffectiveUserIdentity = () => UserIdentity;

/**
 * Return the canonical, private per-user runtime root. The result never depends
 * on HOME, USERPROFILE, TMPDIR, XDG_RUNTIME_DIR, TEMP, TMP or LOCALAPPDATA.
 */
export type ResolveOsRuntimeDirectory = (identity: UserIdentity) => string;
```

WP8b implements and exports constants of both function types from
`src/codex/user-identity.ts`; it does not ship declarations without bodies.

Exact platform algorithm:

- **macOS and Linux:** obtain the effective uid from `getuid(2)` (Bun
  `process.getuid()` is the public call). Require `/tmp` to resolve by
  `realpathSync.native`, be a real directory owned by uid 0, and have the sticky
  bit plus world-write/search semantics. The root is
  `<real-/tmp>/opencodex-runtime-v1-<decimal-uid>`. Create that one component with
  mode `0700`; on every use, `lstat`/descriptor checks require a non-symlink real
  directory, exact effective uid, and exact `0700`. There is no `/run/user`,
  `XDG_RUNTIME_DIR`, `TMPDIR`, home, or cwd fallback. Failure refuses.
- **Windows:** open the current process effective token with `TOKEN_QUERY`, call
  `GetTokenInformation(TokenUser)`, and canonicalize it with
  `ConvertSidToStringSidW`. Blank/malformed SID or any API failure refuses; account
  name and `USERPROFILE` are not fallbacks. Resolve `FOLDERID_LocalAppData` with
  `SHGetKnownFolderPath` for that same effective token, ignoring the `LOCALAPPDATA`
  environment variable. The root is
  `<known-folder>/OpenCodex/Runtime/v1/<canonical-SID>`. Resolve and inspect each
  component without following a reparse redirect, then require/harden an ACL owned
  by that SID that grants only that SID, `SYSTEM`, and `Administrators`. Known-folder,
  SID, canonicalization, reparse, owner, or ACL failure refuses; there is no temp or
  ProgramData fallback.

The lock database path is
`<resolved-per-user-root>/native-write-locks/<sha256-of-canonical-CODEX_HOME>.sqlite`.
POSIX directories are `0700` and files `0600`; Windows applies the required ACL to
the root, database, and rollback journal. Every existing component is checked before
use and again through stable descriptors around SQLite open/transaction boundaries.
A symlink, junction/reparse redirect, wrong owner, broad mode/ACL, or substituted
path is a refusal, never something the resolver repairs in place.

The test that matters, and the one my first version could not have failed: two
child processes with different `HOME`, `USERPROFILE`, `TMPDIR`, `XDG_RUNTIME_DIR`,
`TEMP`, `TMP`, and `LOCALAPPDATA` values but the same effective uid/SID and canonical
`CODEX_HOME` must resolve the same root and take the same lock.

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
survive a write; unparseable fails closed rather than resetting. Missing and
field-free v1 records initialize to `{0,null}` and persist both native fields on
first update. Generation-only/tx-only legacy records refuse. Two updates expecting
the same pair race; exactly one updates and the loser returns `conflict` without
overwriting the winner's txId or pending history schedule.

`tests/codex-convergence-contract.test.ts`: every `ConvergeOutcome` variant maps
to the §5 row, `busy` carries `Retry-After`, and a best-effort management caller
still returns 2xx while reporting a non-converged disposition. Compile the exported
type block with the repository TypeScript compiler so WP8b cannot regress to a
bodyless TS2391 declaration. Table-drive each artifact observation and require
`isApplied` only for the fully applied aggregate.

`tests/codex-user-identity.test.ts`: real child processes vary every environment
home/runtime variable named in §7 and resolve one root/lock for one effective uid or
SID. POSIX activates wrong owner/mode/symlink and non-sticky `/tmp` refusal through a
resolver seam; Windows CI activates token/SID failure, known-folder failure, reparse,
owner, and broad-ACL refusal. No case falls back to an environment directory.

WP10's Worker tests pause an old Worker during traversal, commit a newer transition,
then let the old mutation finish. Its terminal CAS must conflict, the newer pending
state must survive, and the guardian must repair it. Repeat with spawn suppressed,
Worker death, timeout, shutdown cancellation, unreadable/schema probes, and terminal
record-write failure; every failed probe count is null and the latest transition
remains durably schedulable.

**The funnel must be provable, not grepped** (round 2 #2). A grep guard misses a
wrapper in the same module, a re-export, an alias and a dynamic import — and the
tree has all four today: `refreshCodexModelCatalog` wraps the catalog writers
(`src/codex/refresh.ts:40-52`), `restoreNativeCodex` wraps config/catalog/history
removal (`src/codex/inject.ts:764-794`), and `src/codex/catalog.ts:11` re-exports
the direct writers.

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
- Contributes to C15 with detect-and-repair: the latest native pair is durably
  pending before spawn, a stale Worker cannot replace its record, and the guardian
  eventually repairs history. WP10 implements that protocol. Also contributes to
  C2/C12 (generations and the three-read admission/observation sequence).
