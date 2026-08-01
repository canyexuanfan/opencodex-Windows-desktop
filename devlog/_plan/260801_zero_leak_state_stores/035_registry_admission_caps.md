# 035 — registry, flight, discovery, and diagnostic admission caps

Date: 2026-08-01  
Work phase: wp4b (must land before 040)  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §§3–6, `005_impl_roadmap.md` 035 regression classes, `006_roadmap_audit_synthesis.md` S2-1/S2-2/S3-1/S3-3.

## Outcome

Close the operational stores omitted by the initial roadmap audit. Every active registry
gets a finite hard admission cap and coherent busy result; every single-flight has a
finite distinct-key cap and stale-owner policy; discovery and usage payloads are bounded
before full materialization, and MCP payloads are bounded in manager-owned retained
copies (the SDK materializes responses before the manager can measure them — see the
MCP section); retained diagnostic and affinity strings are truncated at
insertion with a visible marker. Existing accepted owners are never silently untracked.

This phase provides retained-byte accounting hooks for 040. It does not implement the
process-wide eviction policy.

## Shared primitives

### NEW `src/lib/admission.ts`

```ts
export const RETAINED_TRUNCATION_MARKER = "\n…[truncated by opencodex]";

export class ResourceAdmissionError extends Error {
  readonly code = "server_busy";
  constructor(readonly resource: string, readonly limit: number);
}
export interface AdmissionMetrics {
  active: number;
  peak: number;
  admitted: number;
  rejected: number;
  releaseMisses: number;
}
export interface AdmissionLease { release(): void }
export function createAdmissionGate(name: string, limit: number): {
  tryAcquire(): AdmissionLease | null;
  metrics(): Readonly<AdmissionMetrics>;
};
export function truncateRetainedUtf8(value: string, maxBytes: number): string;
export function retainedUtf8Bytes(value: string): number;
```

`truncateRetainedUtf8()` cuts on a valid UTF-8 boundary and reserves marker bytes. It
never returns an invalid surrogate fragment. Metrics are scalar-only and monotonic except
`active`; they retain no ids, keys, paths, URLs, commands, request bodies, or errors.

## Debug subscribers and diagnostic rings

Current anchors:

- `src/lib/debug-log-buffer.ts:10-35` retains 2,000 unbounded lines and an unbounded
  listener set. `subscribeDebugLogEntries` currently has NO production consumer:
  `/api/debug/logs` is a polling JSON route (`src/server/management/logs-usage-routes.ts:141-144`),
  not SSE. The cap therefore lands in the owner only; no route change exists or is invented.
- `src/lib/injection-debug-log.ts:10-27` retains 2,000 unbounded lines.
- `src/claude/inbound-debug.ts:40-106` retains 20 variable metadata rows.
- `src/lib/crash-guard.ts:206-245` retains 12 traces with unbounded URL/origin/rejection.
- fixed string slots include `src/lib/sidecar-tracker.ts:10-17,39-44`, startup health,
  main-account cache (`src/codex/main-account-cache.ts:13-20`), shim discovery error
  (`src/codex/shim.ts:32-37` — file input already capped at 1 MiB, the retained error
  string is not), and project-config warnings (`src/codex/project-config-warnings.ts:290-315`).
  GitHub star state (`src/github/star-state.ts:32-38,85-87`) retains only a finite enum
  and is EXCLUDED — truncating it would duplicate an existing finite representation.
- Codex/Anthropic affinities are count-bounded at
  `src/codex/routing.ts:107-108,142,663-721` (now with credential-generation liveness
  at :667-669) and `src/oauth/anthropic-routing.ts:36-37,63-64,245-252,361-389,435-489`,
  but id components are not byte-bounded. New caps must preserve the generation
  validation semantics.

Constants and changes:

```ts
const MAX_DEBUG_SUBSCRIBERS = 64;
const MAX_DEBUG_LINE_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_VALUE_BYTES = 8 * 1024;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
```

- `subscribeDebugLogEntries()` throws `ResourceAdmissionError("debug_subscribers",64)`
  before insertion. Existing subscribers remain active; unsubscribe is idempotent and
  updates release-miss metrics. Since no production route subscribes today, this is a
  defensive owner-side cap for future consumers; no route-level catch is added in this
  phase and the polling `/api/debug/logs` route is untouched.
- Debug/injection lines are truncated before ring insertion and before listener fanout;
  console logging may retain its existing safe line, but no ring stores the original.
- Crash trace URL/origin/rejected fields and fixed-slot strings use the 8 KiB cap at
  assignment. Preserve redaction first, then truncate.
- Affinity key components are normalized at admission. Oversized thread/scope/account ids
  are rejected from affinity caching, not truncated into collision-prone keys; displayed
  diagnostic aliases may be truncated. Existing request routing continues without affinity.

Expose hooks:

```ts
export function debugBufferMetrics(): { entries: number; bytes: number; subscribers: AdmissionMetrics; oldestAt: number | null };
export function injectionBufferMetrics(): { entries: number; bytes: number; oldestAt: number | null };
export function crashRingMetrics(): { entries: number; bytes: number; oldestAt: number | null };
export function evictOldestDebugEntryForBudget(): number;
export function evictOldestInjectionEntryForBudget(): number;
export function evictOldestCrashTraceForBudget(): number;
```

All ring replacements/evictions use centralized subtract helpers.

## Active turns, WebSockets, workers, and slots

Current anchors:

- `src/server/lifecycle.ts:19-29,43-73` registers every live turn with no admission cap.
  CAUTION: several HTTP paths register the turn only AFTER upstream work and response
  construction (`src/server/responses/core.ts:1662-1673,1731-1735,1824-1827`), so a
  drop-in `tryRegisterTurn` swap at those sites cannot reject "before handler work".
- `src/codex/websocket-registry.ts:4-35,47-73` tracks sockets by account until close.
- `src/storage/worker-lifecycle.ts:25-85` tracks workers; spawning is already globally
  serialized and drains prior workers before creating another (:69-85), so a live-worker
  overflow cannot occur through current production paths.
- `src/storage/storage-mutation-coordinator.ts:20-64` has one slot per distinct home but
  no total-home cap.

Production defaults:

```ts
export const MAX_ACTIVE_TURNS = 256;
export const MAX_TRACKED_CODEX_WEBSOCKETS = 128;
export const MAX_ACTIVE_STORAGE_HOME_SLOTS = 32;
```

Change signatures:

```ts
export function tryAdmitTurn(): AdmissionLease | null;        // called at the request boundary
export function tryReserveCodexWebSocket(): AdmissionLease | null; // called BEFORE upgrade
export function tryBeginStorageMutation(...):
  | { acquired: true; lease: AdmissionLease }
  | { acquired: false; error: "storage_mutation_busy" };
```

Turn admission moves to the true request boundary: `tryAdmitTurn()` runs in the server
fetch handler before any adapter/upstream work, and the returned lease is threaded to
the existing `registerTurn`/finish sites so one lease covers the whole response
lifecycle (the late `registerTurn` sites in responses/core.ts bind to the
already-acquired lease rather than acquiring a second one). Lease release is
BOUNDARY-OWNED, not delegated to the late sites: the fetch-handler wrapper releases on
handler exception and on non-stream responses (data-plane handlers return both stream
and non-stream responses — `src/server/index.ts:597-705`, `src/server/relay.ts:311-344`);
for streaming responses the lease transfers exactly once to the response-lifetime
wrapper, whose finish/cancel/error paths release it. A lease that was never transferred
is always released by the boundary. WebSocket capacity is
reserved BEFORE `server.upgrade()` (`src/server/index.ts:370-394`) via
`tryReserveCodexWebSocket()`; the reservation is carried through `WsData` and bound to
the SOCKET LIFECYCLE on `open` (`src/server/index.ts:806-812`) — account-registry
binding happens later when pool auth resolves (`src/server/index.ts:915-920`,
`src/codex/websocket-registry.ts:6-18`) — and the reservation is released on upgrade
failure, open-rejection, and close. HTTP and WS rejects use structured 503
`server_busy`; storage retains `storage_mutation_busy`. Accepted work holds one
idempotent lease released from every current finish/cancel/error/close/finally path.

The 16-live-storage-worker cap is DROPPED from this phase: production spawning is
already serialized-with-drain, so the cap would be dead code. The remaining unbounded
risk is the queued spawn-closure queue (`spawnGate` in
`src/storage/worker-lifecycle.ts`), which this phase bounds directly: a small
admission cap (`MAX_QUEUED_STORAGE_SPAWNS = 8`) rejects further queued spawn closures
with a typed `StorageSpawnQueueBusyError` before enqueueing. Both gate consumers map
that error to their existing structured failure surfaces instead of a generic worker
failure: policy jobs (`src/storage/policy-job.ts:385-389`) surface it as a
`storage_mutation_busy`-class busy result rather than `policy_worker_failed`, and
restore jobs (`src/storage/restore-job.ts:41-65,230-240`) surface it as busy rather
than `restore_worker_failed`. This supersedes the roadmap's
"active workers hard cap" line (`005_impl_roadmap.md` wp4b row) and the inventory's
"cap creation" note (`000_state_store_inventory.md` §Storage workers/slots): the
bounded resource is the QUEUE, not live workers, because liveness is already
serialized. Tests: `queued storage spawn 9 is rejected busy and accepted spawns drain
normally` (cross-registry file) plus owner-level cases in the policy-job and
restore-job suites proving the externally visible busy result (not
`policy_worker_failed`/`restore_worker_failed`) when the queue is full.

Add `activeRegistryMetrics()` returning per-registry `AdmissionMetrics`. `releaseMisses`
is the leak signal: increment only when an unregister/finish path attempts to release an
unknown owner; never remove another owner to hide it.

## Codex credential refresh flights

Current `src/codex/account-store.ts:268-270,349-465` deduplicates by grant fingerprint
and deletes in `finally`, but distinct fingerprints have no cap and a stuck Promise is
joined forever.

```ts
const MAX_CODEX_REFRESH_FLIGHTS = 32;
const CODEX_REFRESH_FLIGHT_STALE_MS = 120_000;
interface RefreshFlight {
  promise: Promise<CodexRefreshResult>;
  startedAt: number;
  abort: AbortController;
}
const refreshLocks = new Map<string, RefreshFlight>();
```

Admission order:

1. Same fingerprint and age <=120 s: join it.
2. Same fingerprint older than 120 s: abort with a typed stale reason, remove only if
   still the same owner, then create a replacement.
3. New fingerprint with 32 live rows: throw
   `CodexCredentialRefreshBusyError` before file lock/fetch.
4. Thread `AbortSignal.any([flight.abort.signal, timeout])` through lock wait and fetch.
5. `finally` deletes only if `refreshLocks.get(key) === flight`.

An aborted stale owner remains awaited by its original callers and settles with a typed
retryable error; it is not silently detached. The replacement is the only mapped owner.

## Management usage-read bound

Current `src/usage/log.ts:389-403,470-511` reads `stat.size` into one Buffer, converts all
text, splits every line, and retains the parsed array in one revision-keyed Promise.

```ts
const MANAGEMENT_USAGE_MAX_READ_BYTES = 64 * 1024 * 1024;
const MANAGEMENT_USAGE_MAX_ENTRIES = 200_000;
const MANAGEMENT_USAGE_FLIGHT_STALE_MS = 30_000;
interface ManagementUsageSnapshot {
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision;
  truncatedPrefixBytes: number;
}
```

- Read at most the newest 64 MiB through bounded 1 MiB chunks; when starting mid-file,
  discard the first partial line.
- Parse batches cooperatively and retain at most the newest 200,000 valid rows.
- Return `truncatedPrefixBytes` so callers/GUI cannot present capped history as complete.
- A 30-second-stale same-revision flight is aborted through a local controller and
  replaced. At most one management usage-read flight exists.
- Never allocate `Buffer.allocUnsafe(stat.size)` for a file over the cap.

Update usage summary/routes to preserve totals for the returned window and expose an
additive `historyTruncated` boolean; do not fabricate lifetime totals.

## Cursor model discovery and gather flights

Inventory anchors:

- `src/adapters/cursor/live-models.ts:98-125` buffers all RPC chunks before applying the
  500-id result cap.
- `src/codex/catalog/provider-fetch.ts:64-129,654-675` keeps one gather Promise per
  distinct config fingerprint without a concurrency cap.

```ts
const CURSOR_MODEL_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_CATALOG_GATHERS = 8;
```

Reject an announced `content-length` above 4 MiB before reading and cancel the body once
streamed chunks exceed 4 MiB. Decode only after admission. Keep the existing 500 model-id
result cap. Add a gate around distinct gather fingerprints; same-fingerprint callers
still join, while the ninth distinct gather receives a typed busy result and starts no
provider requests. Release in `finally` and expose scalar peak/reject counters.

## OAuth flow/probe and pending-code bounds

Generic OAuth flow state (`src/oauth/index.ts:827-837,975-990`) is ONE flow per known
provider with an existing busy result, so its active-flow count is already bounded by
the finite provider registry — no new cap there. The management boundary rejects pasted
input above 4,096 chars at `src/server/management/oauth-account-routes.ts:184-193`, but
that is a character limit and internal callers can bypass the route; owner-side UTF-8
byte validation is still missing at `src/oauth/index.ts:897-921`.

The actually unbounded flow/probe owners live in `src/codex/auth-api.ts`:

- `codexAuthLoginState` (`src/codex/auth-api.ts:93,1175-1370`) — random login-state keys
  with no distinct-key cap.
- `poolQuotaRefreshInFlight` (`src/codex/auth-api.ts:432-440,579-609`) — a map keyed by
  account id whose VALUES are `Set<PoolQuotaRefreshFlight>` holding one flight per
  credential generation; neither the key count nor the total flight-object count is
  capped.

```ts
const OAUTH_PENDING_CODE_MAX_BYTES = 4 * 1024;
const MAX_CODEX_LOGIN_FLOWS = 32;      // codexAuthLoginState distinct keys
const MAX_POOL_QUOTA_FLIGHTS = 16;     // TOTAL flight objects across ALL account sets
```

Enforce pending-code UTF-8 bytes in the owner (`src/oauth/index.ts:897-921`) before
assignment. The Codex login-flow and pool-quota-probe caps are implemented in
`src/codex/auth-api.ts` on the exact owners above; admission happens before timer,
listener, browser/device request, or Promise creation. The pool-quota cap counts TOTAL
flight objects across all per-account sets (a per-key cap would not bound the sum);
compatible-generation callers still join the current flight without consuming a new
admission. The caps MUST preserve the credential-generation flight-set semantics
already present in `poolQuotaRefreshInFlight` (writer-generation fencing from 030).

There is NO existing busy surface for quota probes, so each caller gets a defined
behavior for the typed `PoolQuotaProbeBusyError`:

- management GET `/api/codex-auth/accounts` (`src/codex/auth-api.ts:818-820`): return
  the account list with cached/stale quota values and an additive optional
  `quotaProbeSkipped?: true` field on the PER-ACCOUNT `CodexAuthAccountDto`
  (`src/codex/auth-api.ts:442-457`) for each account whose probe was skipped — never a
  5xx for a busy probe.
- reset-credit refresh (`src/codex/auth-api.ts:1135-1152`): map the busy error to a
  structured 503 `server_busy` with `Retry-After: 1` instead of the current generic 500.
- startup priming (`src/codex/auth-api.ts:631-666`): already best-effort; a busy
  rejection is swallowed like any other priming failure.

Login-flow admission (`MAX_CODEX_LOGIN_FLOWS`) rejects before `startLoginFlow`/browser
work. Note the existing concurrent-flow response is a 409
(`src/codex/auth-api.ts:1372-1377`, "already in progress"); the CAP overflow is a NEW
structured 503 `server_busy` surface — distinct from that 409, which is preserved
unchanged for the same-provider concurrent case.
Existing generation owners remain until their normal finish/abort timer. Reconciliation
of dead provider/account keys remains in 030.

## MiMo bootstrap value cap

Current `src/adapters/mimo-free.ts:27-35,92-133` caches one unbounded JWT and parses the
entire bootstrap JSON after a 15-second fetch timeout.

```ts
const MIMO_BOOTSTRAP_MAX_BYTES = 128 * 1024;
const MIMO_JWT_MAX_BYTES = 64 * 1024;
```

Use bounded response-body reading, reject content-length/chunks above 128 KiB before
`JSON.parse`, require `jwt` UTF-8 bytes <=64 KiB, then cache and parse expiry. Oversized
values throw `MiMo bootstrap response too large`, never enter `cachedJwt`, and preserve
single-flight cleanup.

## Cursor MCP manager payload caps

Current `src/adapters/cursor/mcp-manager.ts:64-70,86-139,152-223` retains configured
connections/tool schemas and materializes tool/resource payloads without local
count/byte caps. SCOPE CORRECTION: the MCP SDK fully materializes responses before the
manager can measure them (`listTools` :123, `callTool` :159-166, `listResources`
:175-177, `readResource` :187-194), so this phase's guarantee is narrowed to bounding
MANAGER-OWNED RETAINED copies — oversized payloads are measured after SDK resolution
and rejected before normalization/copy into manager-owned objects, so nothing over-cap
is retained past the call. Transport/framing-level pre-materialization limits would
require SDK-level changes and are out of scope.

```ts
const CURSOR_MCP_MAX_SERVERS = 32;
const CURSOR_MCP_MAX_TOOLS = 512;
const CURSOR_MCP_MAX_RESOURCES = 1_024;
const CURSOR_MCP_MAX_SCHEMA_BYTES = 256 * 1024;
const CURSOR_MCP_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const CURSOR_MCP_MAX_RESULT_BYTES = 8 * 1024 * 1024;
```

Validate configured server count in the constructor. During `indexTools`, measure
advertised name + description + canonical schema before adding; stop with a typed
catalog-too-large error instead of retaining a partial catalog. Resource listings and
call/read results are measured before normalization/copy into manager-owned objects;
reject over cap. `dispose()` remains authoritative and clears accounting before
awaiting client closes. Do not truncate tool schemas or resource payloads into invalid data.

## Regression tests

Concrete names/fixtures. Put cross-registry lease/accounting cases in NEW
`tests/active-registry-admission.test.ts`; extend existing owner suites for the rest:

- `debug subscriber 65 is rejected while the first 64 still receive entries`
- `subscriber unsubscribe is idempotent and leak metric records unknown release`
- `debug injection crash and fixed-slot strings truncate on UTF-8 boundary with marker`
- `affinity rejects an oversized key component without colliding or changing routing`
- `active turn 257 returns structured server_busy before handler work`
- `websocket 129 rejects upgrade without entering account registry`
- `storage home slot 33 returns storage_mutation_busy without dropping active slots`
- `active registry peak rejected and release-miss metrics are monotonic`
- `same refresh grant joins a live flight`
- `33rd distinct refresh grant is rejected before file lock and fetch`
- `stale refresh flight is aborted and replaced without deleting the replacement`
- `usage reader never requests more than 64 MiB from an oversized log`
- `usage reader returns newest complete capped rows and historyTruncated`
- `stale usage-read flight is replaced and old completion cannot clear new owner`
- `Cursor model discovery rejects announced and streamed 4 MiB overflow before decode`
- `ninth distinct catalog gather is busy while same-fingerprint caller still joins`
- `OAuth pending code rejects 4097 UTF-8 bytes in the owner`
- `Codex login flow 33 rejects before browser work and pool-quota flight 17 (total across accounts) rejects before request creation while a compatible-generation caller still joins`
- `busy pool-quota probe leaves management GET 200 with cached quota and per-account quotaProbeSkipped`
- `busy pool-quota probe maps reset-credit refresh to 503 server_busy with Retry-After 1`
- `busy pool-quota probe is swallowed by startup priming like other priming failures`
- `MiMo accepts exact JWT boundary and rejects one byte over without caching`
- `MCP exact catalog boundary admits and one byte over disposes partial state`
- `MCP oversized tool result and resource are rejected without truncated payload`.

Verification:

```bash
bun test tests/debug.test.ts tests/active-registry-admission.test.ts \
  tests/api-debug.test.ts tests/codex-websocket-registry.test.ts \
  tests/codex-account-store.test.ts tests/usage-log.test.ts tests/cursor-hardening.test.ts \
  tests/gather-routed-models-single-flight.test.ts tests/oauth-manual-code.test.ts \
  tests/codex-auth-api.test.ts tests/mimo-free-provider.test.ts tests/cursor-mcp-manager.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

File ownership is fixed as follows: debug subscriber/value cases extend
`tests/debug.test.ts` and `tests/api-debug.test.ts` (the latter owns the `/api/debug`
route behavior); turns/sockets/slots use the new cross-registry file plus the existing
websocket suite; Codex refresh flights extend `tests/codex-account-store.test.ts`
(NOT `tests/xai-refresh-lock.test.ts`, which owns OAuth/XAI refresh);
usage extends `tests/usage-log.test.ts`; Cursor discovery and gather admission extend
`tests/cursor-hardening.test.ts` and `tests/gather-routed-models-single-flight.test.ts`;
OAuth owner/code and Codex flow/probe cases extend `tests/oauth-manual-code.test.ts` and
`tests/codex-auth-api.test.ts`; MiMo extends `tests/mimo-free-provider.test.ts`; MCP
extends `tests/cursor-mcp-manager.test.ts`. Do not invent parallel test harness names.

## Commit

`fix(runtime): cap registries flights and retained diagnostics`

## Explicitly not changed

- No forced eviction/untracking of accepted turns, sockets, workers, mutation slots,
  refresh grants, OAuth flows, or probes.
- No `#820` scheduler/session-lane architecture.
- No credential, token, account id, URL, path, command, or body in metrics.
- No truncation of JSON tool schemas/results into syntactically valid-looking partials.
- No change to provider retry/rotation, MCP tool execution semantics, or usage-log disk format.
- No process-wide demotion; 040 consumes only the retained-ring accounting hooks.
