# 020 — Cursor blob and replay-cache byte caps

Date: 2026-08-01  
Work phase: wp3  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §§2–3 and “Additional process caches”, `005_impl_roadmap.md` locked decision 2, `006_roadmap_audit_synthesis.md` R1-1/R1-3/R2-2.

## Outcome

Bound all four translation-duty stores owned by this phase at insertion time:

1. Cursor shared blobs: per-blob + aggregate bytes, provenance-aware eviction, and
   pinned-saturation rejection through the existing get-blob miss surface.
2. Antigravity replay: bounded calls and bytes per session while retaining recent
   live identities and clear-on-invalid behavior.
3. Vision descriptions: clamp before insertion and byte-weight the existing LRU.
4. Anthropic image normalization: count key/sentinel metadata and prevent a single
   cache value from bypassing the aggregate cap.

## Current code and verified anchors

- `src/adapters/cursor/native-exec.ts:75-136` stores 4,096 shared blobs with 15-minute
  lazy TTL/count eviction but no byte or provenance field. `setBlob()` returns void.
- `src/adapters/cursor/native-exec.ts:202-227` maps missing `getBlobArgs` to an empty
  `GetBlobResult`; remote `setBlobArgs` always acknowledges after insertion.
- `src/adapters/cursor/protobuf-request.ts:54-60,195-305` limits selected external roots
  to 192/512 KiB only after candidates have been stored. Inventory warning: all
  candidates are stored before selection.
- `src/adapters/google-antigravity-replay.ts:13-24` has a bounded outer map and an
  unbounded inner `Map<string,string>`.
- `src/adapters/google-antigravity-replay.ts:79-98` accumulates every call identity for
  a session; `:105-125` replays live rows; `:128-135` clears on invalid/reset.
- `src/vision/index.ts:18-24,32-68` has a 256-entry LRU with no value-byte accounting.
- `src/vision/index.ts:197-204` clamps only when rendering, while `:341-343` caches the
  unclamped `outcome.text.trim()`.
- `src/adapters/anthropic-image-normalize.ts:96-143` gives `pass`/`miss` zero weight,
  has no entry cap, and inserts a single encoded value even if it exceeds 64 MiB.

Blast-radius constraints from the inventory: missing Cursor blobs break hydration;
clearing Antigravity identities can cause invalid-signature 400s; clearing vision/image
caches repeats paid or expensive work. The remedy is bounded admission/LRU, not deletion
of the translation feature.

## Cursor blob-store diff

Modify `src/adapters/cursor/native-exec.ts`:

```ts
const BLOB_TTL_MS = 15 * 60_000;
const BLOB_MAX_ENTRIES = 4_096;
const BLOB_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const BLOB_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

type CursorBlobProvenance = "local-regenerated" | "remote-setBlobArgs";
interface CursorBlobEntry {
  data: Uint8Array;
  storedAt: number;
  sizeBytes: number;
  provenance: CursorBlobProvenance;
}
type CursorBlobAdmission =
  | { admitted: true; replaced: boolean }
  | { admitted: false; reason: "entry_too_large" | "pinned_saturation" };

let blobBytes = 0;
function setBlob(k: string, data: Uint8Array, provenance: CursorBlobProvenance): CursorBlobAdmission;
function deleteBlob(k: string): void;
function evictExpiredBlobs(at: number): void;
function evictOldestLocalBlob(): boolean;
```

Admission ladder for every insert, including replacement:

1. Reject `data.byteLength > BLOB_MAX_ENTRY_BYTES`; do not remove an existing same-key
   row until admission is known to succeed.
2. Sweep all TTL-expired rows, regardless of insertion order/provenance.
3. Compute projected bytes after subtracting a same-key replacement.
4. While projected bytes exceed the aggregate cap, evict the oldest
   `local-regenerated` row. A remote row is pinned only while its TTL is live.
5. If still over cap, reject with `pinned_saturation`; the store and byte counter remain
   unchanged.
6. On success, delete the old row through `deleteBlob()`, insert the immutable byte view,
   add exact `byteLength`, and refresh Map recency.
7. Apply the 4,096 count cap using the same policy: expired, then oldest local. If only
   live remote rows remain, reject rather than evict a pin or exceed the cap.

`storeCursorBlob(data)` remains `Uint8Array -> Uint8Array`: it computes and returns the
SHA-256 id even if admission rejects. A later `getBlobArgs` receives the existing empty
result—the explicit protocol miss surface. It passes `local-regenerated`.

`setBlobArgs` passes `remote-setBlobArgs`. `SetBlobResult` has no typed rejection field,
so it still acknowledges transport receipt; a rejected hash is intentionally absent and
subsequent `getBlobArgs` returns the explicit miss. Add one privacy-safe diagnostic
counter, not the hash or blob bytes.

Expose accounting for 040:

```ts
export interface CursorBlobMetrics {
  count: number;
  totalBytes: number;
  localBytes: number;
  pinnedBytes: number;
  rejectedEntryTooLarge: number;
  rejectedPinnedSaturation: number;
  oldestAt: number | null;
}
export function cursorBlobMetrics(): CursorBlobMetrics;
export function evictOldestCursorBlobForBudget(): number; // local only; bytes released
```

Metrics read cached fields only. Add test-only reset/cap overrides; production constants
remain fixed.

## Antigravity replay diff

Modify `src/adapters/google-antigravity-replay.ts`:

```ts
const REPLAY_MAX_CALLS_PER_SESSION = 256;
const REPLAY_MAX_BYTES_PER_SESSION = 2 * 1024 * 1024;
const REPLAY_MAX_SIGNATURE_BYTES = 64 * 1024;

interface ReplayCall { signature: string; sizeBytes: number; touchedAtMs: number }
interface ReplayEntry {
  byCall: Map<string, ReplayCall>;
  bytes: number;
  expiresAtMs: number;
}
```

Use `TextEncoder` byte lengths for canonical call key + signature. On observation:

- ignore an individual call whose signature or combined row exceeds its cap;
- replace through a centralized delete/subtract helper;
- insert/refresh the observed call as newest;
- evict oldest inner calls until both count and bytes fit;
- refresh the outer session TTL only when at least one valid call was inserted;
- delete expired outer entries during observe/apply and retain the existing outer cap.

`applyAntigravityReplay()` refreshes inner recency when a signature is actually matched;
it does not refresh session TTL. `clearAntigravityReplay()` still deletes the entire
session immediately after an upstream invalid-signature response (`src/adapters/google.ts:451-455`).

Expose scalar accounting/test seams:

```ts
export function antigravityReplayMetrics(): {
  sessions: number; calls: number; totalBytes: number; largestSessionBytes: number;
};
```

## Vision description-cache diff

Modify `src/vision/index.ts`:

```ts
const DESCRIPTION_CACHE_MAX_ENTRIES = 256;
const DESCRIPTION_CACHE_MAX_BYTES = 1024 * 1024;

interface VisionDescriptionCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
  metrics?(): { count: number; totalBytes: number; oldestAt: number | null };
}
```

`BoundedLruDescriptionCache` stores `{value,sizeBytes,storedAt}` and tracks key UTF-8
bytes plus value UTF-8 bytes. Replacement subtracts first; eviction happens before
insert until count and projected bytes fit. A single value that cannot fit is not cached.

At `src/vision/index.ts:341-343`, change the insertion value to:

```ts
const successfulText = outcome.error ? "" : clamp(outcome.text.trim(), DESC_MAX_CHARS);
if (identity.persistent && successfulText) descriptionCache.set(identity.key, successfulText);
```

Return the same clamped text in `outcome` so first use and cache hit are byte-identical.
Do not clamp error markers or change paid-sidecar admission/concurrency.

## Image-normalization cache diff

Modify `src/adapters/anthropic-image-normalize.ts:96-143`:

```ts
const CACHE_BYTE_CAP = 64 * MiB;
const CACHE_MAX_ENTRIES = 4_096;
const CACHE_MAX_ENTRY_BYTES = 20 * MiB;
type CacheValue = { data: string; mediaType: string } | "pass" | "miss";
interface CacheEntry { value: CacheValue; sizeBytes: number; storedAt: number }
```

`sizeBytes` includes UTF-8 key bytes for every row, sentinel marker bytes, media type,
and encoded data. `cachePut()` returns `boolean`; it skips an individually oversized
entry and evicts before insertion until both count and aggregate byte caps fit. There is
no zero-weight path. `cacheGet()` preserves true LRU and returns `entry.value`.

Extend `getNormalizeStatsForTests()` and the 040 hook with `sentinelEntries`,
`metadataBytes`, and `oldestAt`. Budget eviction removes the oldest row through the same
centralized subtract helper.

## Cap rationale

- Cursor 16 MiB per blob is 32 times the external selected-root budget and still admits
  native conversation-step/KV payloads, while rejecting protocol-scale allocations long
  before the 32 MiB translator frame ceiling. The 64 MiB aggregate matches the existing
  continuation/image-cache order of magnitude and gives four maximum entries or many
  ordinary roots without allowing the 4,096 count cap to imply TiB retention.
- Antigravity 256 calls is more than ten times the normal 20+ parallel-call acceptance;
  2 MiB/session permits roughly 8 KiB per identity on average. A 64 KiB signature ceiling
  is far above observed opaque signatures but prevents one value from consuming the
  entire session budget.
- Vision keeps the established 256 identities. The 1 MiB aggregate holds hundreds of
  ordinary short descriptions; clamp-before-insert guarantees every retained value is
  at most the existing 2,000-character presentation contract, so paid-call reuse remains
  useful while pathological upstream prose cannot dominate the process.
- Image normalization keeps a generous 4,096-row metadata ceiling so pass/miss reuse is
  not destroyed by screenshot churn. The 20 MiB per-entry ceiling matches Anthropic's
  final aggregate image-share contract and is above every normal ladder output; the
  existing 64 MiB aggregate remains the stronger ordinary constraint.

## Regression tests

`tests/cursor-blob.test.ts`:

- `admits a local blob exactly at the per-blob byte boundary`
- `rejects a local blob one byte above the per-blob boundary and getBlob returns miss`
- `replacement subtracts old bytes and refreshes local LRU`
- `aggregate admission evicts oldest local-regenerated blobs first`
- `remote setBlobArgs remains pinned within TTL while local blobs are evicted`
- `expired remote setBlobArgs becomes evictable before aggregate admission`
- `pinned saturation rejects a new remote blob without exceeding aggregate bytes`
- `rejected same-key replacement preserves the previously admitted blob`
- `blob metrics remain observe-only and exact after reset replacement and eviction`.

`tests/google-antigravity-replay.test.ts`:

- `preserves 20+ live signed calls below count and byte caps`
- `evicts oldest inner call at the exact per-session count boundary`
- `evicts oldest inner calls to satisfy aggregate session bytes`
- `does not cache one oversized signature`
- `apply refreshes matched call recency without extending session TTL`
- `clear-on-invalid drops the bounded session and all byte accounting`.

`tests/vision-cache.test.ts`:

- `clamps a successful description before cache insertion and first render`
- `cache hit returns the same clamped description without a sidecar call`
- `vision LRU evicts before insert at the aggregate byte boundary`
- `one oversized cache value is observed but not retained`.

`tests/anthropic-image-normalize.test.ts`:

- `unique pass and miss sentinels consume metadata bytes and hit the count cap`
- `encoded replacement keeps aggregate accounting exact`
- `one encoded value above maxEntrySize is returned but not cached`
- `cache eviction occurs before insertion and never exceeds 64 MiB`.

Verification:

```bash
bun test tests/cursor-blob.test.ts tests/google-antigravity-replay.test.ts \
  tests/vision-cache.test.ts tests/anthropic-image-normalize.test.ts
bun run typecheck
bun run test
```

## Commit

`fix(state): bound Cursor blobs and translation replay caches`

## Explicitly not changed

- No Cursor blob-id/hash format, protobuf schema, selected-root 192/512 KiB policy,
  hydration lookup, or remote TTL change.
- No eviction of live remote blobs merely to admit another pinned blob.
- No Antigravity identity algorithm, canonical JSON format, signature validity threshold,
  Claude-on-Antigravity behavior, or clear-on-invalid behavior.
- No vision sidecar backend/model selection, paid-call concurrency, cache identity, or
  image-description wording beyond using the existing clamp earlier.
- No image tier ladder, decode validation, wire mutation, demotion order, or 20 MiB
  request-level image budget.
- No process-wide budget; 040 only consumes the accounting/demotion hooks defined here.
