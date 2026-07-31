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

In-flight translator buffers and serialized-tail backlogs are observed as current/high-
water counters but never evicted by this budget. Their hard admission is owned by 050.

## Current code and anchors

- `src/server/management/system-routes.ts:1-31` documents scalar/privacy constraints.
- `src/server/management/system-routes.ts:33-95` assembles process memory,
  `responseState`, inspector counters, watchdog, and active-turn scalars.
- `src/responses/state.ts:371-408` is an existing observe-only retained-store seam.
- `src/server/memory-watchdog.ts:53-60,102-155` owns a separate warn-only RSS/native
  watchdog with a 360-sample bounded ring; it does not manage app-owned state.
- `src/types.ts:531-725` contains the top-level `OcxConfig` runtime fields.
- `src/config.ts:703-733` begins the Zod config schema and reaches adjacent scalar
  fields; write-time validation follows
  the existing positive-integer helpers at `:530-550`.
- `src/server/index.ts:300-316` starts process-wide memory/scheduler singletons.
- `tests/memory-watchdog.test.ts:162-233` pins the current endpoint scalar shape.

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
does not duplicate bytes. Snapshot collection catches one owner failure and reports its
store as zeros; it never invokes `evictOldest()`.

## Retained-store registrations

Register hooks delivered by 010/020/035 and existing owners:

| Category | Store ids | Demotion rule |
|---|---|---|
| logs | `request_log`, `provider_debug`, `injection_debug`, `claude_debug`, `crash_ring` | Remove oldest complete diagnostic row; never truncate an attempt array during budget enforcement. |
| caches | `image_normalize`, `vision_descriptions`, `antigravity_replay`, `model_cache`, `usage_summary` | Remove oldest LRU/session/provider value through owner accounting. Preserve “other” usage totals. |
| blobs | `cursor_blobs` | Remove oldest local-regenerated blob only. Live remote blobs report as pinned. |
| continuation | `responses_continuation` | Demote oldest resident row through 010 durable spill. Spill stubs/tombstones are not repeatedly demoted. |

The request-log owner (`src/server/request-log.ts:150-154,218-246`) must add per-entry
UTF-8 byte accounting and a centralized oldest delete. Normalize individual retained
diagnostic strings per 035, but preserve retry/failover attempt structure.

Model cache and usage summary values receive owner-local byte accounting before they can
register. Usage summary overflow aggregates excess model cardinality into an `other`
bucket without dropping token/cost totals; it is not permissible to delete totals.

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
`oldestAt` is earliest. Re-snapshot after every demotion; never trust a stale projected
counter across a spill or replacement. A per-run visited/no-progress set prevents loops.

Call enforcement after successful retained-store insertion/replacement, after startup
registrations, and after live config budget changes. Observation happens first: update
owner bytes, then enforce. Never reject new request admission as the first lever.

Edge contracts:

- A single entry over global budget is demoted/evicted even when it is the only entry.
- Pinned-only saturation may leave `overBudgetBytes > 0`; record
  `noEvictableCandidate`, warn once per 60 seconds, and do not violate per-store pinning.
- Continuation spill failure follows 010 tombstone eviction and counts released RAM;
  budget enforcement does not keep the row hot.
- If a callback throws or reports zero release, move to the next candidate without
  spinning and retain honest over-budget metrics.
- Budget decrease is applied synchronously through the same demotion order.

## `/api/system/memory` payload

At `src/server/management/system-routes.ts:74-95`, add:

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
    "noEvictableCandidate": 0
  }
}
```

## Regression tests

Add `tests/app-owned-memory.test.ts`:

- `snapshot is observe-only and never calls an eviction callback`
- `replacement registration cannot double-count one store id`
- `exact budget boundary performs no demotion`
- `one byte over budget demotes oldest log before newer log`
- `category order beats cross-category timestamp order`
- `cache demotion starts only after logs and rings have no candidates`
- `local blobs demote before continuation and pinned remote bytes remain`
- `continuation is the final demotion category and uses durable spill callback`
- `single retained entry over budget is demoted even when it is the only entry`
- `pinned-only saturation reports honest overBudgetBytes and noEvictableCandidate`
- `zero-release and throwing callbacks cannot spin or hide over-budget bytes`
- `replacement and eviction byte accounting remains exact across all hooks`
- `translator and serialized-tail observations never invoke budget eviction`
- `budget decrease enforces synchronously in the documented order`.

Extend `tests/memory-watchdog.test.ts`:

- `GET system memory includes privacy-safe appOwnedBytes scalars`
- `GET system memory does not load prune serialize or evict retained stores`
- `payload contains no dynamic store keys paths ids or diagnostic text`.

Config tests:

- `appOwnedMemoryBudgetMb defaults to 256 MiB`
- `accepts integer bounds 64 and 4096`
- `rejects management writes below above fractional or nonnumeric values`
- `malformed persisted value degrades to default without dropping providers`.

Run:

```bash
bun test tests/app-owned-memory.test.ts tests/memory-watchdog.test.ts tests/config.test.ts
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
- No GUI redesign beyond consuming the additive payload if desired in docs sync.
