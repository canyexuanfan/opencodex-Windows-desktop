# 010 — continuation hard cap with durable per-entry spill

Date: 2026-08-01  
Work phase: wp2  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §1, `005_impl_roadmap.md` locked decision 1, `006_roadmap_audit_synthesis.md` R1-3/R2-1.

## Outcome

Make the Responses continuation store authoritative but unconditionally bounded in RAM.
An entry that would leave resident bytes above 64 MiB is synchronously written to a
dedicated id-keyed spill file, fsynced, atomically renamed, and only then
replaced by a small RAM stub. Any write failure removes the resident entry and records
a bounded tombstone. A stub whose file is missing or corrupt produces the same explicit
structured continuation-not-found response; it never forwards a naked delta.

The legacy debounced `responses-state.json` path remains the persistence path for small
resident entries. Its 2 MiB per-entry and 24 MiB snapshot selection rules are not reused
as the spill mechanism and are not relaxed.

No new 010 configuration surface is added. Keep the owner-local RAM ceiling fixed at
64 MiB and retain only the existing test override; 040 owns the configurable process-wide
retained-state budget. A separate continuation knob would create two user settings with
overlapping demotion authority and could raise the local store above the global budget.

## Current contract and verified anchors

- `src/responses/state.ts:6-20` owns count, TTL, 64 MiB nominal RAM cap, legacy snapshot
  limits, and stale snapshot-temp cleanup.
- `src/responses/state.ts:22-78` has one resident shape, one `states` map, one byte
  counter, and centralized `setEntry()` / `deleteEntry()` accounting.
- `src/responses/state.ts:202-250` lazily loads v1/v2 monolithic snapshots and treats
  corrupt snapshots as an empty cache.
- `src/responses/state.ts:252-299` performs debounced best-effort snapshot writes. It
  skips a serialized pair above 2 MiB and stops newest-first selection at 24 MiB.
- `src/responses/state.ts:319-334` prunes TTL/count and then bytes only while
  `states.size > 1`. This is the last-entry exemption to delete.
- `src/responses/state.ts:336-350` returns the original request on every miss; the
  caller cannot distinguish ordinary absence from a known broken spill.
- `src/responses/state.ts:363-408` reads provider metadata and exposes observe-only
  metrics without loading, pruning, or serializing.
- `src/responses/state.ts:415-455` synchronously stores expanded input plus output and
  immediately prunes/schedules persistence.
- `src/server/responses/core.ts:1092-1115` expands before parsing and detects expansion
  only by object identity.
- `src/server/responses/core.ts:1228-1239,1338-1343` already returns structured 400s for
  canonical-forward and Kiro misses, while `:1445-1449` still warns and forwards a
  passthrough naked delta.
- `tests/responses-state.test.ts:535-555` asserts the obsolete “newest survives even
  when over cap” policy.
- `tests/responses-state.test.ts:660-883` covers restart, stale/corrupt snapshots, and
  the obsolete “oversized stays in RAM but is skipped on disk” contract at `:856-883`.

Inventory blast-radius constraint: “evicting/rejecting the newest row makes the next
chained turn a naked delta.” This phase therefore spills or emits an explicit miss; it
does not truncate replay history.

## File changes

### NEW `src/responses/spill-store.ts`

Own all spill filesystem I/O. Do not put spill code in the generic config writer: the
legacy writer is best-effort and does not fsync.

```ts
export const RESPONSE_SPILL_VERSION = 1;
export const RESPONSE_SPILL_DIR_NAME = "responses-state-spill";
export const RESPONSE_SPILL_ORPHAN_GRACE_MS = 15 * 60_000;
export const RESPONSE_SPILL_SCAN_MAX = 4_096;
export const RESPONSE_SPILL_CLEANUP_MAX = 512;

export interface ResponseSpillPayload {
  version: 1;
  responseId: string;
  createdAt: number;
  items: unknown[];
  providers?: OcxProviderContinuationState;
}

export interface ResponseSpillRef {
  version: 1;
  fileName: string;     // sanitized response id + id digest + payload size
  digest: string;       // lowercase SHA-256 of the exact UTF-8 file bytes
  payloadBytes: number;
}

export type ResponseSpillReadResult =
  | { ok: true; payload: ResponseSpillPayload }
  | { ok: false; reason: "missing" | "corrupt" };

export interface ResponseSpillCleanupResult {
  scanned: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
}

export function writeResponseSpillDurably(
  responseId: string,
  state: Omit<ResponseSpillPayload, "version" | "responseId">,
): ResponseSpillRef;
export function readResponseSpill(ref: ResponseSpillRef): ResponseSpillReadResult;
export function deleteResponseSpill(ref: ResponseSpillRef): void;
export function recoverOrphanedResponseSpills(
  referencedFileNames: ReadonlySet<string>,
  dir?: string,
): ResponseSpillCleanupResult;
```

`writeResponseSpillDurably()` transaction, in this exact order:

1. Serialize `{version:1,responseId,createdAt,items,providers}` once and compute UTF-8
   bytes and SHA-256 from those exact bytes.
2. Build an id-keyed basename
   `<sanitized-id>.<id-digest-12>.<payloadBytes>.spill.json`. Normalize the id to NFC,
   replace every character outside `[A-Za-z0-9._-]` with `_`, collapse repeated `_`,
   trim the visible portion to 80 characters, and use `response` if it becomes empty.
   `id-digest-12` is the first 12 lowercase hex characters of SHA-256(responseId), so
   ids that sanitize/truncate to the same visible text cannot collide. Require the full
   owned-file regex before joining it to the spill directory.
3. Resolve `<config>/responses-state-spill/<basename>`; create/harden the directory
   to user-only permissions.
4. Open a same-directory unique temp with `wx` and mode `0600`.
5. Write all bytes, call `fsyncSync(fd)`, close the descriptor, and harden the temp.
6. Rename temp to the id-keyed destination. If the basename already exists, accept it
   only after regular-file, exact-size, response-id, and full-digest verification;
   otherwise replace it through another same-directory temp. Replacement of a response
   id deletes the old basename only after the new rename and stub swap succeed.
7. Return the ref only after rename succeeds. On every failure, close/unlink the temp
   best-effort and rethrow a sanitized error containing no response id or path.

The id-keyed layout is selected over content-addressing because lifecycle, replacement,
TTL, and tombstone ownership are all by response id. A sanitized visible component makes
orphan diagnosis practical, the size component permits bounded startup accounting
without opening every file, and the short id digest prevents collisions after
sanitization/truncation. The full content digest remains in the stub and is verified on
read; neither visible id nor filename size is trusted as integrity proof.

This phase deliberately uses a synchronous transaction. `rememberResponseState()` is
called from synchronous bridge completion callbacks (`src/bridge.ts:143,811-817` and
`src/server/relay.ts:498,680-718`); an un-awaited asynchronous spill would permit an
unbounded pending-write closure chain and a post-response stub race. The synchronous
path is the bounded in-flight window: at most one transaction exists on the JS thread,
with no queue. Spills are exceptional, not the small-entry hot path.

`readResponseSpill()` must reject symlinks/non-regular files, require the basename to
match the owned regex, require stat size to match both the filename size and
`ref.payloadBytes`, enforce ref/content digest equality, validate the exact schema and
matching `responseId`, and return `corrupt` on any parse,
shape, or digest failure. Never return partial items.

### MODIFY `src/responses/state.ts`

Replace the monomorphic row with this union:

```ts
interface ResidentResponseState {
  kind: "resident";
  createdAt: number;
  items: unknown[];
  providers?: OcxProviderContinuationState;
  sizeBytes: number;
}
interface SpilledResponseState {
  kind: "spill";
  createdAt: number;
  providers?: OcxProviderContinuationState;
  spill: ResponseSpillRef;
  sizeBytes: number; // cached serialized stub bytes, not payloadBytes
}
interface SpillFailedResponseState {
  kind: "spill-failed";
  createdAt: number;
  sizeBytes: number;
}
type StoredResponseState = ResidentResponseState | SpilledResponseState | SpillFailedResponseState;

export type PreviousResponseReplayFailure = {
  code: "previous_response_not_found";
  reason: "spill_missing" | "spill_corrupt" | "spill_failed";
};
```

Add a private `WeakMap<object, PreviousResponseReplayFailure>` beside
`replayedInputPrefixLengths` and an observe-only accessor:

```ts
export function previousResponseReplayFailure(body: unknown): PreviousResponseReplayFailure | undefined;
```

Centralize transitions; no caller mutates `states`, counters, or spill files directly:

```ts
function setResidentEntry(id: string, entry: ResidentInput): void;
function swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): void;
function replaceWithSpillFailure(id: string, expected?: StoredResponseState): void;
function deleteEntry(id: string, options?: { deleteSpill?: boolean }): void;
function materializeEntry(id: string, entry: StoredResponseState):
  | { ok: true; state: ResidentResponseState }
  | { ok: false; failure: PreviousResponseReplayFailure };
```

`deleteEntry()` subtracts the row's RAM `sizeBytes`; for a spill stub it also unlinks
the dedicated file unless `deleteSpill:false` is used during a verified load/swap.
Replacement and TTL/count eviction therefore remove old spill files.

Replace the byte loop with:

```ts
while (storedResponseBytes > byteCap() && states.size > 0) {
  const oldestId = states.keys().next().value as string | undefined;
  if (!oldestId) break;
  const entry = states.get(oldestId)!;
  if (entry.kind !== "resident") { deleteEntry(oldestId); continue; }
  try {
    const ref = writeResponseSpillDurably(oldestId, entry);
    swapResidentForSpill(oldestId, entry, ref); // only after durable success
  } catch {
    replaceWithSpillFailure(oldestId, entry);   // R2-1: no hot oversized row
    spillCounters.writeFailures++;
  }
}
```

After each swap/tombstone, re-check the condition. A stub/tombstone that alone exceeds
the test override is deleted, so the invariant remains `storedResponseBytes <= byteCap()`.
Delete the `states.size > 1` exemption and update the old test-only cap comment.

`expandPreviousResponseInput()` behavior:

- resident: current expansion, unchanged;
- spill: read and fully validate, expand from payload, set replay provenance;
- missing/corrupt spill: leave body unchanged, set the failure WeakMap, increment the
  matching counter, delete the stub and bad/missing file best-effort, then insert a
  `spill-failed` tombstone for deterministic later calls;
- spill-failed: leave body unchanged and set `{code, reason:"spill_failed"}`;
- ordinary absent/TTL-expired id: preserve the current generic miss behavior.

`previousResponseProviderState()` reads the provider copy on a spill stub without loading
the payload. Tombstones return undefined.

Extend metrics without filesystem reads:

```ts
export interface ResponseStateMetrics {
  count: number;
  residentCount: number;
  spillStubCount: number;
  tombstoneCount: number;
  totalBytes: number;
  spillPayloadBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillReadFailures: number;
}
```

`spillPayloadBytes` is the sum of refs, not file stat calls. `responseStateMetrics()`
remains observe-only.

Snapshot compatibility:

- Keep `version:2` and the exact current serialization/selection for resident rows.
- Persist spill stubs and tombstones because both are small; never inline spill payload.
- Continue accepting v1/v2 resident rows and recomputing resident bytes locally.
- On first load, collect referenced basenames, run orphan cleanup, then prune. Startup
  cleanup removes unreferenced valid spill/temp names only after the 15-minute grace;
  it never follows symlinks and obeys scan/cleanup caps.
- `clearResponseStateMemoryForTests()` clears memory only. `clearResponseStateForTests()`
  also removes this test home's spill directory after deleting known refs.

### MODIFY `src/server/responses/core.ts`

Immediately after `body = expandPreviousResponseInput(body)` and before parsing, inspect
`previousResponseReplayFailure(body)`. Return one canonical response for all three known
failure reasons:

```ts
formatErrorResponse(
  400,
  "previous_response_not_found",
  "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
)
```

Add a `classifyError()` branch in `src/lib/errors.ts` mapping that explicit type to
`{type:"invalid_request_error", code:"previous_response_not_found"}`. Do not expose
the spill reason, response id, digest, path, or OS error. Remove the `:1445-1449`
warn-and-forward path for known spill failures; ordinary upstream-capable misses retain
their existing routing behavior.

## Regression tests

Extend `tests/responses-state.test.ts` with these exact tests/fixtures:

- `spills the only oversized continuation and leaves resident bytes at or below cap`
- `does not swap a resident row to a stub before fsync and rename succeed`
- `replays provider metadata and function_call_output history through a spill stub`
- `replays a durable spill after simulated process restart`
- `returns previous_response_not_found for a missing spill file without forwarding delta`
- `returns previous_response_not_found for a corrupt or digest-mismatched spill`
- `spill write failure evicts resident bytes and records one bounded tombstone`
- `disk permission failure increments spillWriteFailures without retaining payload`
- `replacing a response id deletes its previous dedicated spill file`
- `TTL and count eviction delete dedicated spill files and release stub bytes`
- `startup orphan cleanup removes only old unreferenced regular spill files`
- `startup orphan cleanup preserves referenced young live and unrelated files`
- `concurrent flush and synchronous demotion cannot inline or lose the spill stub`
- `small entries retain the legacy v2 debounced snapshot representation`
- redefine `tests/responses-state.test.ts:535` as
  `byte cap spills the newest-only chain instead of exempting it`;
- redefine `tests/responses-state.test.ts:856` as
  `oversized entries replay from dedicated spill across restart while small entries use snapshot`.

Add endpoint coverage in `tests/server-combo-failover-e2e.test.ts` (or the nearest
Responses endpoint test) named:

- `known continuation spill failure returns structured previous_response_not_found before upstream I/O`.

Fixtures must use an injected spill I/O seam, not chmod-only assertions that are unreliable
on Windows. The durability-order test records `write`, `fsync`, `close`, `harden`, `rename`,
`stub-swap` and asserts that order exactly.

Verification:

```bash
bun test tests/responses-state.test.ts tests/server-combo-failover-e2e.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Commit

`feat(responses): hard-cap continuation state with durable spill`

## Explicitly not changed

- No replay truncation, history compaction, provider-metadata dropping, or naked-delta fallback.
- No use of the 2 MiB/24 MiB monolithic snapshot as spill storage.
- No change to small-entry debounce timing or newest-first snapshot selection.
- No change to `store:false` force policy, partial-output eligibility, replay provenance,
  Cursor checkpoint semantics, or Kiro conversation identity.
- No provider adapter logic, request body cap, stream relay, or `#820` scheduler/lease work.
- No user-visible spill paths/digests and no security notes outside this closed implementation unit.
