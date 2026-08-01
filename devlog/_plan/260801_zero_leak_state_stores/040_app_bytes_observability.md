# 040 — app-owned byte observability and retained-store budget

Date: 2026-08-01  
Work phase: wp5  
Depends on: 010, 020, 035 (030 provides no accounting hook)  
Binding inputs: `000_state_store_inventory.md`, `005_impl_roadmap.md` budget scope split and locked decision 4, `006_roadmap_audit_synthesis.md` R1-6/S2-3/S3-1.

## Outcome

Expose one privacy-safe `appOwnedBytes` block on authenticated
`GET /api/system/memory`, then enforce a configurable 256 MiB process-wide budget over
evictable retained stores only. Enforcement always demotes oldest unpinned retained
entries in fixed category order:

`logs/rings -> caches -> blobs -> continuation spill`.

040 wires the `ObservedBufferRegistration` registry and the scalar management shape, but
registers NO production observed-buffer owners: `observedInFlight` is `{}` when 040 lands
alone. Phase 050 owns the translator/tail instrumentation and, as its integration contract,
adds `registerDefaultAppOwnedObservedBuffers()` in `src/lib/app-owned-memory-stores.ts`,
calls it beside 040's retained-store registration at startup, and registers only static ids
(`translator_buffers`, `image_fulfillment_tail`, `oauth_mutation_tail`,
`grok_apply_flight`) through 040's `registerObservedBuffer()`. Once 050 lands those
current/high-water counters become visible, but they remain pinned observation-only state
and are never evicted by this budget. Their hard admission is owned by 050.

## Current code and anchors

- `src/server/management/system-routes.ts:1-30` documents scalar/privacy constraints.
- `src/server/management/system-routes.ts:35-97` assembles process memory,
  `responseState`, inspector counters, watchdog, and active-turn scalars.
- `src/responses/state.ts:640-695` is the observe-only retained-store seam
  (`responseStateMetrics()` — resident/stub/tombstone counts, payload bytes, spill
  counters from 010). It does NOT yet expose `evictableBytes`, `pinnedBytes`, or the
  oldest-resident timestamp; this phase adds all-row accounting plus a resident-only
  eviction API
  (see the continuation pre-work section below).
- `src/server/memory-watchdog.ts:53-60,102-155` owns a separate warn-only RSS/native
  watchdog with a 360-sample bounded ring; it does not manage app-owned state.
- `src/types.ts:531-535` starts the top-level `OcxConfig` runtime fields beside the
  existing management usage-memory control.
- `src/config.ts:739-748` begins the Zod config schema; positive-integer helpers are
  at `:566-585`. Load-time degradation and write-time rejection are SEPARATE
  boundaries: the schema rule degrades malformed persisted edits to the default, and
  a raw-candidate guard beside the hostname guard at `src/config.ts:1416-1444` makes
  `validateConfigCandidate` reject invalid candidates before Zod can normalize them.
  The actual MANAGEMENT boundary is `/api/settings` PUT
  (`src/server/management/config-routes.ts:74-78,113-142,192-227`) — full `/api/config` PUT
  is disabled — so this phase adds `appOwnedMemoryBudgetMb` to `/api/settings`
  GET/PUT: the PUT validates the integer 64..4096 range, persists, then calls
  `configureAppOwnedMemoryBudget` + `enforceAppOwnedMemoryBudget` synchronously.
  Tests extend `tests/settings-stream-mode.test.ts`.
- `src/server/index.ts:264-273,311-317` starts process-wide singletons: state
  reconciliation at 266/273, watchdog at 316, state-store sweeper at 317. The
  app-owned registrations + first enforcement run belong beside the sweeper start.
- `tests/memory-watchdog.test.ts:162-236` pins the current endpoint scalar shape
  (11 responseState scalars, no appOwnedBytes yet).

## Config decision

Choose a user-configurable top-level MiB field, not an environment-only or fixed knob:

```ts
export interface OcxConfig {
  /** Evictable retained app-state budget in MiB. Default 256; valid 64..4096. */
  appOwnedMemoryBudgetMb?: number;
}

export const DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;
export const MIN_APP_OWNED_MEMORY_BUDGET_MB = 64;
export const MAX_APP_OWNED_MEMORY_BUDGET_MB = 4_096;
export function resolveAppOwnedMemoryBudgetBytes(value: unknown): number;
```

Rationale: 256 MiB leaves room for the existing 64 MiB continuation, 64 MiB Cursor
blob, and 64 MiB image-normalization ceilings plus bounded logs/caches, while still
forcing cross-store demotion before retained state becomes multi-GiB. MiB is readable in
`config.json`; all metrics remain bytes. Reject non-integer/out-of-range values at the
management write boundary. On load, malformed legacy hand edits degrade to the default
without resetting unrelated config, following existing schema doctrine.

Because the schema intentionally catches an invalid persisted value, add
`appOwnedMemoryBudgetError(value: unknown): string | null` beside
`blankHostnameError()` and include it in `validateConfigCandidate()` BEFORE
`configSchema.safeParse()`. It inspects the raw candidate's own
`appOwnedMemoryBudgetMb` value and rejects nonnumeric, non-finite, fractional, below-64,
or above-4096 values. Extend `tests/cli-headless-parity.test.ts:167-186` with the named
behavioral regression `config set and import reject an invalid app-owned memory budget
without persisting the normalized default`; assert both CLI paths return nonzero and the
previous file remains byte-for-byte/field-for-field unchanged.

Update English and translated configuration tables. This is a user-facing operational
control, so docs cannot be English-only or imply it caps RSS/native memory.

## NEW `src/lib/app-owned-memory.ts`

```ts
export type AppOwnedRetainedCategory = "logs" | "caches" | "blobs" | "continuation";
export type AppOwnedObservedCategory = "translator" | "serialized_tails";

export interface RetainedStoreSnapshot {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
}
export interface RetainedStoreRegistration {
  id: string;
  category: AppOwnedRetainedCategory;
  snapshot(): RetainedStoreSnapshot;       // observe-only, no sweep/load/serialization
  evictOldest(): number;                   // bytes released; 0 means no candidate
}
export interface ObservedBufferRegistration {
  id: string;
  category: AppOwnedObservedCategory;
  snapshot(): { currentBytes: number; highWaterBytes: number; active: number };
}
export interface AppOwnedBytesSnapshot {
  budgetBytes: number;
  retainedBytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  overBudgetBytes: number;
  stores: Record<string, RetainedStoreSnapshot>;
  observedInFlight: Record<string, { currentBytes: number; highWaterBytes: number; active: number }>;
  enforcement: {
    runs: number;
    entriesDemoted: number;
    bytesReleased: number;
    noEvictableCandidate: number;
    snapshotFailures: number;
    oldestAtContractViolations: number;
  };
}

export function registerRetainedStore(registration: RetainedStoreRegistration): () => void;
export function registerObservedBuffer(registration: ObservedBufferRegistration): () => void;
export function configureAppOwnedMemoryBudget(bytes: number): void;
export function appOwnedBytesSnapshot(): AppOwnedBytesSnapshot;
export function enforceAppOwnedMemoryBudget(): AppOwnedBytesSnapshot;
export function resetAppOwnedMemoryForTests(): void;
```

Registrations are unique by static id. Duplicate registration replaces callbacks and
does not duplicate bytes or change that id's original owner-order slot. Snapshot
collection catches each throwing retained or observed owner, substitutes the appropriate
all-zero scalar shape, and increments `enforcement.snapshotFailures` exactly once per
caught snapshot invocation; it never invokes `evictOldest()`. The scalar failure total is
exposed in `GET /api/system/memory`; no error text or dynamic owner data is retained.

## Retained-store registrations

Add `src/lib/app-owned-memory-stores.ts` with one fixed
`APP_OWNED_RETAINED_STORE_REGISTRATIONS` readonly array and
`registerDefaultAppOwnedMemoryStores()`. The array order is exactly the store-id order in
the table below and is the deterministic owner tie-break order. Startup registers this
array once; test re-registration of an existing static id replaces its callbacks while
preserving its array index. 040 does not add an observed-owner array entry; the named 050
integration point is defined in Outcome.

Register hooks delivered by 010/020/035 and existing owners. The delivered 035 hook
shapes use `entries` (not `count`) and omit pinned/evictable fields, so each
registration is a NAMED ADAPTER in `app-owned-memory` registration code mapping the
owner hook onto `RetainedStoreSnapshot` (rings: `evictableBytes = bytes`,
`pinnedBytes = 0`). Delivered hooks:

- `debugBufferMetrics` / `evictOldestDebugEntryForBudget` (`src/lib/debug-log-buffer.ts:65-70`)
- `injectionBufferMetrics` / `evictOldestInjectionEntryForBudget` (`src/lib/injection-debug-log.ts:43-48`)
- `claudeInboundDebugMetrics` / `evictOldestClaudeInboundForBudget` (`src/claude/inbound-debug.ts:155-160`)
- `crashRingMetrics` / `evictOldestCrashTraceForBudget` (`src/lib/crash-guard.ts:277-282`)
- caches: `src/adapters/anthropic-image-normalize.ts:216-235`,
  `src/vision/index.ts:119-133`, `src/adapters/google-antigravity-replay.ts:220-247`
- blobs: `src/adapters/cursor/native-exec.ts:84-134,396-421` (provenance/pin classes
  map directly onto pinned/evictable)

| Category | Store ids | Demotion rule |
|---|---|---|
| logs | `request_log`, `provider_debug`, `injection_debug`, `claude_debug`, `crash_ring` | Remove oldest complete diagnostic row; never truncate an attempt array during budget enforcement. |
| caches | `image_normalize`, `vision_descriptions`, `antigravity_replay`, `model_cache`, `usage_summary` | Remove oldest LRU/session/provider value through owner accounting. Preserve “other” usage totals. |
| blobs | `cursor_blobs` | Remove the oldest EVICTABLE row (unpinned local, or expired unpinned remote — 020 round-4). Live remote and request-pinned blobs report as pinned. |
| continuation | `responses_continuation` | Demote oldest resident row through 010 durable spill. Spill stubs/tombstones are not repeatedly demoted. |

The request-log owner (`src/server/request-log.ts:150-154,218-246`) must add per-entry
UTF-8 byte accounting and a centralized oldest delete. Normalize individual retained
diagnostic strings per 035, but preserve retry/failover attempt structure. The
current mutation anchor is `src/server/request-log.ts:244-246` (push/shift only, no
byte hook yet).

Model cache and usage summary values receive owner-local byte accounting before they can
register. Usage summary overflow aggregates excess model cardinality into an `other`
bucket without dropping token/cost totals; it is not permissible to delete totals.
Current owners: `src/codex/model-cache.ts:16-19,43-49,121-149` (unaccounted model arrays
with an existing `fetchedAt`) and
`src/server/management/logs-usage-routes.ts:82-86,187-211` +
`src/usage/summary.ts:415-417` (unaccounted summaries, unbounded model breakdown —
the `other` bucket does not exist yet and is created in this phase). The `other`
contract covers BOTH the top-level `models` aggregation (`src/usage/summary.ts:415-417`)
AND every per-day `days[].models` breakdown (`src/usage/summary.ts:290-337`), each of
which independently builds an unbounded provider/model map; unique request counts,
attempts, tokens, and cost are preserved in the bucket wherever applicable.

Every registration's `oldestAt` is the timestamp of the exact row its
`evictOldest()` would remove next, never merely the oldest pinned or unrelated row:

| Store ids | `oldestAt` source |
|---|---|
| `request_log` | Oldest retained `RequestLogEntry.timestamp`. |
| `provider_debug`, `injection_debug`, `claude_debug`, `crash_ring` | Oldest row's existing `at`. |
| `image_normalize`, `vision_descriptions` | Oldest LRU row's `storedAt`, refreshed by the existing cache-hit behavior. |
| `antigravity_replay` | Minimum `touchedAtMs` of the next complete session selected for eviction; snapshot and eviction use the same session comparison. |
| `model_cache` | Oldest provider entry's existing `fetchedAt`. |
| `usage_summary` | New owner-local `revisionReadAt`, captured immediately after `readUsageSnapshotForManagement()` returns and stored with that revision-backed cache entry; do not use response serialization time. |
| `cursor_blobs` | Existing `storedAt` of the exact oldest evictable local or expired-unpinned remote row. |
| `responses_continuation` | Oldest resident row's `createdAt`; stubs/tombstones are excluded from candidacy. |

## Continuation pre-work (fold-in of verified external findings)

040 adds these exact owner exports to `src/responses/state.ts` beside the observe-only
metrics seam at `src/responses/state.ts:640-695`:

```ts
export function responseContinuationRetainedStoreSnapshot(): {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
};
export function evictOldestResponseContinuationForBudget(): number;
```

The snapshot is side-effect-free and does not lazy-load, prune, spill, or serialize.
`count` and `bytes` cover ALL in-RAM rows using each row's cached `sizeBytes`, including
the actual small retained bytes of spill stubs and spill-failure tombstones.
`evictableBytes` is the gross cached bytes of resident rows only; `pinnedBytes` is the
actual cached bytes of stubs/tombstones (budget-protected metadata, not a request pin),
so `bytes === evictableBytes + pinnedBytes`. Stubs and tombstones are never global-budget
eviction candidates. `oldestAt` is the oldest resident `createdAt`, or null when no
resident exists. `evictOldestResponseContinuationForBudget()` demotes exactly that one
resident through the durable spill/tombstone path and returns NET released RAM:
`gross resident sizeBytes - actual replacement stub/tombstone sizeBytes`; no resident or
no net release returns 0.

Three verified defects sit exactly on this phase's continuation/sweeper seam and are
repaired here BEFORE the budget work builds on them:

1. **Bounded snapshot retry (state.ts:448-487, VALID High).** `persistNow()` loops
   until `revision === stateRevision`; sustained traffic keeps it spinning and
   `flushResponseState()` (:511-518) never settles at shutdown. Fix: cap the rewrite
   loop at 4 attempts. If the final write is still revision-unstable, schedule a
   follow-up flush and DO NOT drain `pendingSpillUnlinks` — only a revision-stable
   snapshot may authorize unlinking superseded spill generations (:488-493).
   Follow-up contract: the follow-up retains the SAME captured `path` (the guard at
   :501-508 against recomputing `snapshotPath()` stays intact). Background
   persistence uses an unref'd timer. Explicit `flushResponseState()` (shutdown path,
   `src/server/lifecycle.ts:164-166`) AWAITS one bounded same-path follow-up pass
   after the cap; if that pass is still unstable it returns with a best-effort
   snapshot and intact pending unlinks — shutdown is never blocked indefinitely.
   Test: revision churn during atomic write settles within the bound and leaves
   pending unlinks intact until a stable snapshot lands.

2. **Resident-first demotion (state.ts:539-556, VALID High/data loss).** The RAM-cap
   loop deletes the oldest spill stub/tombstone (including its durable spill file,
   :131-143) whenever it precedes a resident. Fix: scan for the oldest RESIDENT and
   demote it first; delete stubs/tombstones only when no resident remains and
   bounded metadata alone exceeds the cap. This also makes the 040 continuation
   `evictOldest()` callback resident-only by construction.
   Test: mixed older-stub/newer-resident state demotes the resident and keeps the
   stub's durable spill file on disk.

3. **GCP ADC expiry sweep unwired (VALID Medium).** `sweepExpiredGcpAdcTokens()`
   (`src/lib/gcp-adc.ts:71-80`) is exported but `STATE_STORE_REGISTRATIONS`
   registers only `reconcileGcpAdcTokens` (`src/lib/state-store-registrations.ts:97`).
   Wire the expiry sweep into the registration's TTL callback. Test: expired ADC
   token is swept by the periodic pass.

A fourth external claim (sweeper partial-pass fence dropping newly-added-owner
writes) was audited INVALID against current source — every fenced writer also
accepts keys in the owner's live-key set — but a partial-failure/live-key regression
test is added to pin that property.

## Enforcement algorithm

```ts
const CATEGORY_ORDER: readonly AppOwnedRetainedCategory[] = [
  "logs", "caches", "blobs", "continuation",
];

while (retainedBytes() > budgetBytes) {
  const candidate = oldestEvictableStoreInFirstNonemptyCategory(CATEGORY_ORDER);
  if (!candidate) { counters.noEvictableCandidate++; break; }
  const released = candidate.evictOldest();
  if (released <= 0) markCandidateIneligibleForThisRun(candidate);
  else recordAndContinue(released);
}
```

Within the first category that has any evictable bytes, choose the store whose
`oldestAt` is earliest. Equal timestamps are broken by the fixed
`APP_OWNED_RETAINED_STORE_REGISTRATIONS` array index; this is a total order, not Map or
import-order accident. If a snapshot reports `evictableBytes > 0` with `oldestAt ===
null` (or a non-finite timestamp), increment
`enforcement.oldestAtContractViolations` once for that owner in the outer pass, skip it
for the remainder of the current pass, and
continue with the next valid owner. Re-snapshot after every demotion; never trust a stale
projected counter across a spill or replacement. A per-run visited/no-progress set
prevents loops.

The complete trigger set is:

- after every successful retained-store insertion or replacement (owner accounting first);
- once after all startup registrations and budget configuration;
- synchronously after every valid live budget change;
- after a pin/class transition makes existing bytes newly evictable: Cursor
  `releaseHydratedBlob()` / `releaseCursorBlobRequestScope()` after class reconciliation
  (`src/adapters/cursor/native-exec.ts:146-183,196-208,343-365`) and the remote-blob TTL
  expiry timer after it recomputes class accounting; and
- as a fail-safe after each existing periodic sweep tick finishes expiry/liveness
  reconciliation (`src/lib/state-store-sweeper.ts:130-140`), covering coarse TTL expiry
  and pin-release reconciliation without adding another timer.

Observation happens first: update owner bytes/classification, then enforce. Never reject
new request admission as the first lever.

Enforcement is synchronous single-flight with an `isEnforcing` guard. Only the outermost
call increments `runs`; a reentrant call returns the current scalar snapshot without
starting a nested pass or changing run/demotion counters. Owner eviction may use the same
replacement helper as ordinary writes: continuation resident-to-stub replacement is
therefore allowed to encounter the guard, but it cannot recurse. The outer pass
re-snapshots and continues. Each successful callback that produces positive actual net
release increments `entriesDemoted` once and adds that net release to `bytesReleased`
once; zero/throwing callbacks do neither, and `noEvictableCandidate` increments at most
once per outer pass. Evictions performed inside an enforcement pass never schedule a
second deferred pass.

Edge contracts:

- A single entry over global budget is demoted/evicted even when it is the only entry.
- Pinned-only saturation may leave `overBudgetBytes > 0`; record
  `noEvictableCandidate`, warn once per 60 seconds, and do not violate per-store pinning.
- Continuation spill failure follows 010 tombstone replacement and counts net released RAM;
  budget enforcement does not keep the row hot.
- If a callback throws or reports zero release, move to the next candidate without
  spinning and retain honest over-budget metrics.
- Budget decrease is applied synchronously through the same demotion order.

## `/api/system/memory` payload

At `src/server/management/system-routes.ts:76-97` (beside `responseState` at :90), add:

```ts
appOwnedBytes: appOwnedBytesSnapshot(),
```

Retain `responseState` for compatibility during this unit; it may duplicate a scalar
subset. `appOwnedBytes` contains only static store ids, categories, counts, byte totals,
timestamps/ages, and counters. It must never include keys, ids, model/provider names,
paths, hashes, errors, commands, tool arguments, prompts, URLs, or account data.

Recommended wire example:

```json
{
  "budgetBytes": 268435456,
  "retainedBytes": 0,
  "evictableBytes": 0,
  "pinnedBytes": 0,
  "overBudgetBytes": 0,
  "stores": {},
  "observedInFlight": {},
  "enforcement": {
    "runs": 0,
    "entriesDemoted": 0,
    "bytesReleased": 0,
    "noEvictableCandidate": 0,
    "snapshotFailures": 0,
    "oldestAtContractViolations": 0
  }
}
```

## Regression tests

Add `tests/app-owned-memory.test.ts`:

- `snapshot is observe-only and never calls an eviction callback`
- `replacement registration cannot double-count one store id`
- `exact budget boundary performs no demotion`
- `one byte over budget demotes oldest log before newer log`
- `equal oldestAt ties evict the earlier registered owner first`
- `category order beats cross-category timestamp order`
- `cache demotion starts only after logs and rings have no candidates`
- `local blobs demote before continuation and pinned remote bytes remain`
- `continuation is the final demotion category and uses durable spill callback`
- `single retained entry over budget is demoted even when it is the only entry`
- `pinned-only saturation reports honest overBudgetBytes and noEvictableCandidate`
- `zero-release and throwing callbacks cannot spin or hide over-budget bytes`
- `throwing snapshot reports zero owner scalars and increments snapshotFailures`
- `evictable bytes with null oldestAt increments oldestAtContractViolations and skips the owner`
- `continuation demotion releases resident bytes minus retained replacement stub bytes`
- `pin release and remote TTL expiry trigger enforcement after class reconciliation`
- `continuation replacement during enforcement is non-reentrant and counts one demotion`
- `replacement and eviction byte accounting remains exact across all hooks`
- `observed-buffer registry is wired but empty until 050 and never participates in eviction`
- `budget decrease enforces synchronously in the documented order`.

Continuation pre-work tests (extend `tests/responses-state.test.ts` and
`tests/state-store-sweeper.test.ts` / `tests/gcp-adc.test.ts`):

- `persistNow settles within the bounded rewrite attempts under revision churn`
- `unstable final snapshot defers spill unlinks until a stable snapshot`
- `RAM cap demotes the oldest resident before deleting any older spill stub`
- `stub-only over-cap state still deletes bounded metadata oldest-first`
- `expired GCP ADC token is removed by the periodic sweep registration`
- `partial reconcile failure keeps live-key writes accepted for new owners`.

Extend `tests/memory-watchdog.test.ts`:

- `GET system memory includes privacy-safe appOwnedBytes scalars`
- `GET system memory does not load prune serialize or evict retained stores`
- `payload contains no dynamic store keys paths ids or diagnostic text`.

Config tests:

- `appOwnedMemoryBudgetMb defaults to 256 MiB`
- `accepts integer bounds 64 and 4096`
- `settings PUT rejects below/above/fractional/nonnumeric budget values`
- `settings PUT applies a valid budget change synchronously through enforcement`
- `malformed persisted value degrades to default without dropping providers`
- `config set and import reject an invalid app-owned memory budget without persisting the normalized default`.

Run:

```bash
bun test tests/app-owned-memory.test.ts tests/memory-watchdog.test.ts tests/config.test.ts \
  tests/cli-headless-parity.test.ts
bun test tests/responses-state.test.ts tests/state-store-sweeper.test.ts \
  tests/gcp-adc.test.ts tests/settings-stream-mode.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`feat(memory): enforce an app-owned retained-state byte budget`

## Explicitly not changed

- No RSS/native-memory restart threshold or watchdog behavior.
- No eviction of in-flight translator buffers, promise-tail closures, active turns,
  sockets, workers, refreshes, OAuth flows, or MCP calls.
- No first-line request rejection while an evictable retained candidate exists.
- No pin override for live remote Cursor blobs.
- No path/id/account/provider/model/prompt/tool/error content in observability.
- No 030 dependency or accounting hook; expiration sweeping stays independent.
  (Exception: the GCP expiry-sweep wiring above touches the 030 registration table
  because the defect lives there; it adds no accounting coupling.)
- No GUI redesign beyond consuming the additive payload if desired in docs sync.

Docs sync for the new config field covers English AND the translated configuration
references (`ja`, `ko`, `ru`, `zh-cn`).
