# WP8b — the shared surfaces, owned once

Audit round 1 (`006_audit_synthesis.md`) failed four ways on one cause: four
phase docs, written in parallel, each invented its share of a surface they all
touch. Two claimed ownership of `integrations/codex.json` with incompatible
`version: 1` shapes. Three defined `/api/sync`. The lock forbade awaitable work
while history moved into a Worker, so the lock serialized nothing. And 16
management callers were rewired to a helper no phase's admission covered.

This phase lands first and owns all of it. WP9-WP12 consume; they do not extend.

## IN / OUT

IN: `src/codex/integration-record.ts` (NEW — the sole owner),
`src/codex/convergence.ts` (NEW — the single entry point),
`src/codex/generation.ts` (NEW), `src/server/management/context.ts` (MODIFY),
`tests/codex-integration-record.test.ts` (NEW),
`tests/codex-convergence-contract.test.ts` (NEW).

OUT: every behavior. This phase defines shapes, names and one funnel; it moves no
catalog bytes, touches no history, takes no lock. That is deliberate — a contract
phase that also implements is a contract phase nobody can audit separately.

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

`updateIntegrationRecord(mutate)` does one read-modify-write under the same
coordinator the config uses, and **preserves unknown top-level keys verbatim** so
a newer version's record survives an older binary.

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
  /** What the caller wants. `observe` writes nothing and is the status read. */
  intent: "apply" | "remove" | "observe";
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
  | { kind: "converged"; changed: boolean; observed: CodexObservedState; generation: number }
  | { kind: "skipped"; reason: "desired-off" | "already-converged"; observed: CodexObservedState }
  | { kind: "refused"; authority: "service-home" | "external-provider" | "journal" | "provenance"; message: string }
  | { kind: "busy"; surface: "lock" | "history" | "config"; retryAfterMs: number }
  | { kind: "deferred"; unresolved: readonly ("history")[]; observed: CodexObservedState }
  | { kind: "failed"; surface: string; message: string };
```

**Best-effort callers stay best-effort.** The 16 management callbacks keep their
2xx and report the outcome in a `catalogRefresh` field; they do not start
failing loudly because a catalog refresh deferred. What changes is that the
outcome is *visible* instead of swallowed by a bare `catch`.

## 3. Generations, because content equality is not revision equality

Audit #5 and #6. `mutatePersistedConfig` documents its own limit
(`src/config.ts:1855-1857`):

> A writer that ignores the coordinator can still change bytes after the final
> check because the filesystem has no portable conditional rename.

And a content hash passes an A→B→A cycle, which may still have moved the cache,
the backup or the provenance ledger.

So two monotonic counters, both in the record from §1:

- **`generation`** — bumped by every cooperating native commit.
- the config's own revision, read as part of the admission snapshot in §4.

The rule, and it is the whole point of the counters:

> Read both immediately before the native commit, and **again immediately
> after**. A post-commit mismatch means somebody wrote underneath us: the
> outcome is NOT `converged`, the record is left `unresolved`, and convergence
> re-runs. We never claim a commit we cannot prove was the last one.

That is weaker than a transaction and it is honest about it: we detect
interference rather than prevent it.

**Target identity, not path strings.** A candidate records the canonical parent
directory and the file identity (dev+inode where available) of each target, not
the textual path — a parent symlink can retarget while the path string is
unchanged, and `atomicWriteFile` only resolves the effective target at commit
time (`src/config.ts:190-199`).

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
| `skipped` (`desired-off`) | 409 | `{ ok: false, reason: "desired-off", observed }` |
| `skipped` (`already-converged`) | 200 | `{ ok: true, changed: false, observed }` |
| `refused` | 409 | `{ ok: false, authority, message, observed }` |
| `busy` | 503 + `Retry-After` | `{ ok: false, surface, retryAfterMs }` |
| `deferred` | 200 | `{ ok: true, changed, unresolved, observed }` |
| `failed` | 500 | `{ error: message, surface }` |

`busy` is 503 with `Retry-After` because it is transient and the client should
retry; `refused` and `desired-off` are 409 because retrying changes nothing until
a human acts. `deferred` is 200 because the requested work DID happen — history
is outstanding and named, not failed.

## 6. History is serialized across processes, not just in one

Audit #1, the finding with no home. `030`'s locked callback is synchronous and
forbids awaitable work; `020` puts history in a Worker with an in-process flight.
So the lock never covers history — and the real path writes the backup manifest
and rollout files OUTSIDE its SQLite transaction
(`src/codex/history-provider.ts:606,626`), so two processes converging in
opposite directions corrupt each other through files SQLite never guarded.

The contract: **history has its own cross-process lock, acquired INSIDE the
Worker, held across the whole history unit** — manifest read, rollout writes and
the DB transaction together. It is a sibling of the §3 native lock, not nested
inside it, precisely because the native lock's section must stay synchronous.

Ordering, to make the absence of deadlock checkable: **native lock → history
lock, never the inverse.** The native section releases before the Worker is
asked for history.

## 7. Names

Audit #13. Fixed here so no phase invents a variant:

| Thing | Module |
|---|---|
| the native write lock | `src/codex/codex-write-lock.ts` |
| the record | `src/codex/integration-record.ts` |
| the entry point | `src/codex/convergence.ts` |
| generations | `src/codex/generation.ts` |
| history worker | `src/codex/history-worker.ts` |

## 8. Baseline classes, from a live incident

`005_disable_leaves_a_broken_file.md`: a disable left `~/.pi/agent/models.json`
as `{}`, which violates Pi's schema because `providers` is required. The client
refused to start.

So a provenance baseline is one of three, and a remover must know which:

| Class | On removal |
|---|---|
| `absent` | delete, if the post-image hash still matches |
| `present` | restore the recorded baseline bytes |
| `present-required-nonempty` | restore to a VALID minimum for that client — never a bare `{}` unless `{}` is what preceded us |

## Test plan

`tests/codex-integration-record.test.ts`: a v1 record with only `history` is
valid to a provenance reader and vice versa (audit #3); unknown top-level keys
survive a write; unparseable fails closed rather than resetting.

`tests/codex-convergence-contract.test.ts`: every `ConvergeOutcome` variant maps
to the §5 row, `busy` carries `Retry-After`, and a best-effort management caller
still returns 2xx while reporting a non-converged disposition.

A grep-level guard test: no module outside `convergence.ts` imports the catalog
commit or the remover directly. That is how C14 stays true as callers are added.

## Accept criteria

- C14 — all 16 management callers funnel through `convergeCodex`, enforced by the
  import guard test.
- C16 — one owner, one schema; a record from any phase reads in every other.
- C17 — an A→B→A cycle between gather and commit is detected by generation, and
  a parent-symlink retarget is detected by target identity.
- Contributes to C15 (the history protocol is specified here, implemented in
  WP10) and to C2/C12 (generations and the admission snapshot).
