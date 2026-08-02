# 040 — WP4 management API routes

Implementation plan only. WP1-WP3 are prerequisites. This work package adds
the management-plane HTTP adapter over their registry, state, journal, and
writer contracts; it does not add a second integration model or duplicate
writer policy in the server layer.

## 1. Scope boundary

### 1.1 IN

WP4 changes exactly these files:

1. `src/server/management/integration-routes.ts` — new route module, pasted
   from §4.
2. `src/server/management-api.ts` — one import and one dispatch-chain slot,
   exactly as shown in §5.
3. `tests/management-integration-routes.test.ts` — new route-contract suite,
   specified in §7.

### 1.2 OUT

- No changes to `src/integrations/registry.ts`, `state.ts`, `journal.ts`, or
  `writer.ts`; WP4 consumes their landed contracts.
- No serializer, parser, ownership, fingerprint, compare-before-commit,
  snapshot, retention, or GC logic in the route module.
- No GUI, CLI, data-plane (`/v1/*`), client detection, export, docs-site,
  dependency, config-schema, or i18n changes.
- No `requireManagementAuth` call inside `integration-routes.ts`. The server
  authenticates `/api/*` and enforces GUI-session CSRF before
  `handleManagementAPI` dispatch (`src/server/index.ts:448-454`).
- No direct file reads or writes from the route module. In particular, the
  journal snapshot returned by `readSnapshot` is checked for existence only
  and is never serialized into an HTTP response.
- No takeover endpoint. `conflict` remains a refusal for apply/disable; full
  snapshot restore is the only drift-confirmed overwrite in WP4.
- No bulk apply/disable route. The GUI can sequence single-client toggles in a
  later work package.

## 2. Prerequisite contract and route-owned types

WP4 imports only the agreed WP1-WP3 exports:

```ts
import {
  INTEGRATION_CLIENTS,
  type IntegrationClientId,
} from "../../integrations/registry";
import { readIntegrationState } from "../../integrations/state";
import {
  listOperations,
  readSnapshot,
} from "../../integrations/journal";
import {
  applyIntegration,
  disableIntegration,
  restoreIntegration,
} from "../../integrations/writer";
```

The HTTP envelope types are derived from those exports so WP4 cannot drift
from the landed WP1-WP3 discriminants:

```ts
type IntegrationStateRecord = Awaited<ReturnType<typeof readIntegrationState>>;
type IntegrationOperation = Awaited<ReturnType<typeof listOperations>>[number];
type ApplyResult = Awaited<ReturnType<typeof applyIntegration>>;
type DisableResult = Awaited<ReturnType<typeof disableIntegration>>;
type RestoreResult = Awaited<ReturnType<typeof restoreIntegration>>;

export type IntegrationStateEnvelope = {
  clientId: IntegrationClientId;
} & IntegrationStateRecord;

export interface IntegrationStateListEnvelope {
  clients: IntegrationStateEnvelope[];
}

export type IntegrationToggleEnvelope =
  | ({ clientId: IntegrationClientId } & ApplyResult)
  | ({ clientId: IntegrationClientId } & DisableResult);

export type IntegrationRestoreEnvelope = {
  clientId: IntegrationClientId;
} & RestoreResult;

export interface IntegrationJournalEnvelope {
  operations: IntegrationJournalRow[];
}

/**
 * A journal row as the GUI needs it. WP2 stores durable facts; these two
 * fields are DERIVED per request because storing them would go stale the
 * moment anything else wrote the file (020 §4 "Undo binding").
 *
 * - `snapshotAvailable`: false once WP2's 10-per-client GC collected the
 *   snapshot. The row survives as history; the action does not. The GUI
 *   renders `integrations.journal.expired` (004 §6.1, 070 §1).
 * - `undoable`: true only when this is the newest operation for its client
 *   AND the target file's current fingerprint still equals the row's
 *   `resultFingerprint`. Older rows and post-hoc foreign edits both degrade
 *   to a restore offer, never a silent multi-step rewind.
 */
export type IntegrationJournalRow = IntegrationOperation & {
  snapshotAvailable: boolean;
  undoable: boolean;
};

export interface IntegrationToggleBody {
  enabled: boolean;
}

export interface IntegrationRestoreBody {
  opId: string;
  confirmDrift?: boolean;
}

export type IntegrationRouteError =
  | { error: "invalid integration client"; code: "invalid_integration_client"; validClients: readonly IntegrationClientId[] }
  | { error: "invalid JSON body"; code: "invalid_json_body" }
  | { error: "enabled must be a boolean"; code: "invalid_enabled" }
  | { error: "opId must be a non-empty string"; code: "invalid_op_id" }
  | { error: "confirmDrift must be a boolean"; code: "invalid_confirm_drift" }
  | { error: "integration operation not found"; code: "integration_operation_not_found"; opId: string }
  | { error: "integration snapshot expired"; code: "integration_snapshot_expired"; opId: string }
  | { error: "integration mutation busy"; code: "integration_mutation_busy"; clientId: IntegrationClientId }
  | { error: "integration config is unsafe"; code: "integration_unsafe"; clientId: IntegrationClientId; state: "unsafe"; reason: string }
  | { error: "integration config conflicts with ownership record"; code: "integration_conflict"; clientId: IntegrationClientId; state: "conflict"; reason: string }
  | { error: "restore requires drift confirmation"; code: "integration_drift_confirmation_required"; clientId: IntegrationClientId; state: string; reason: string }
  | { error: "integration mutation failed"; code: "integration_mutation_failed"; clientId: IntegrationClientId; state: string; reason: string }
  | { error: string; code: "integration_internal_error" };
```

`IntegrationStateRecord` is the WP2 object containing `state`, fingerprints,
and `configPath`. A list item adds only `clientId`; the route does not rename
or recompute any state fields. `IntegrationOperation` is returned as WP3
stores it, excluding snapshot bytes by contract; the route decorates it with
the two derived booleans above and nothing else.

**Derivation (route-side, per request).** `snapshotAvailable` is
`readSnapshot(opId) !== null` — an existence check only, never a content
read, so a journal response can never leak a client's file bytes.
`undoable` compares the row against `listOperations(clientId)[0]` and the
live file fingerprint from `readIntegrationState(clientId)`. Both are cheap
reads already performed elsewhere in this module.

**Activation scenarios.** `snapshotAvailable: false` — produce 11 operations
for one client and assert the oldest row is still present with the flag false
while `POST restore` on it returns the 410 envelope (the two must agree, and
a test asserts exactly that pairing). `undoable: false` on a foreign edit —
apply, append a byte to the target file, then assert the newest row flips to
`undoable: false` while remaining `snapshotAvailable: true`, i.e. the GUI
offers restore instead of undo.

OPEN QUESTION — WP3 must make `readSnapshot(opId)` return `null` when an
operation row exists but its retained snapshot has been garbage-collected.
The paste-ready code and the required 410 branch use that sentinel. If WP3
landed a different explicit sentinel, change only the equality check in §4;
do not collapse “unknown operation” and “expired snapshot” into one status.

OPEN QUESTION — the supplied WP3 summary names a `reason` discriminant but
does not give its literal for an unconfirmed drift restore. §3-§4 reserve
`"drift_requires_confirm"`; WP3 must confirm or adopt that literal before the
paste. Do not infer drift from a generic `conflict` state, because that would
conflate ownership conflict with the restore-specific confirmation path.

## 3. Exact route table

### 3.1 Success routes

| Method | Path | Request | 200 response |
|---|---|---|---|
| `GET` | `/api/client-integrations` | no body | `IntegrationStateListEnvelope`; exactly one item for each `INTEGRATION_CLIENTS` entry, in registry order |
| `GET` | `/api/client-integrations/:clientId` | no body | `IntegrationStateEnvelope` |
| `PUT` | `/api/client-integrations/:clientId` | `IntegrationToggleBody`; `true` calls `applyIntegration(clientId, ctx)`, `false` calls `disableIntegration(clientId)` | `IntegrationToggleEnvelope`; preserves `ok`, `changed`, `state`, `opId`, and `reason` from WP3 |
| `POST` | `/api/client-integrations/restore` | `IntegrationRestoreBody`; omitted `confirmDrift` is `false` | `IntegrationRestoreEnvelope`; calls `restoreIntegration(opId, { confirmDrift })` only after operation and snapshot preflight |
| `GET` | `/api/client-integrations/journal` | no body; optional `?client=IntegrationClientId` | `IntegrationJournalEnvelope`; newest-first ordering remains WP3-owned |

`GET` state may return `state: "unsafe"` with HTTP 200 because unsafe is an
observable state, not a failed read. Unsafe becomes a 409 only when a write is
attempted and the writer refuses it.

### 3.2 Exact error responses

| Status | Trigger | Exact JSON body |
|---|---|---|
| 400 | unknown path client or unknown `journal?client=` filter | `{"error":"invalid integration client","code":"invalid_integration_client","validClients":["opencode","pi","hermes","openclaw","kimi","gajae"]}` |
| 400 | malformed JSON for `PUT` or `POST restore` | `{"error":"invalid JSON body","code":"invalid_json_body"}` |
| 400 | missing/non-boolean `enabled` | `{"error":"enabled must be a boolean","code":"invalid_enabled"}` |
| 400 | missing, non-string, or blank `opId` | `{"error":"opId must be a non-empty string","code":"invalid_op_id"}` |
| 400 | present non-boolean `confirmDrift` | `{"error":"confirmDrift must be a boolean","code":"invalid_confirm_drift"}` |
| 404 | `opId` has no journal row | `{"error":"integration operation not found","code":"integration_operation_not_found","opId":"<request opId>"}` |
| 409 | another non-stale mutation flight owns that client | `{"error":"integration mutation busy","code":"integration_mutation_busy","clientId":"<clientId>"}` |
| 409 | apply/disable/restore writer result has `state: "unsafe"` | `{"error":"integration config is unsafe","code":"integration_unsafe","clientId":"<clientId>","state":"unsafe","reason":"<writer reason>"}` |
| 409 | apply/disable, or confirmed restore, returns `state: "conflict"` | `{"error":"integration config conflicts with ownership record","code":"integration_conflict","clientId":"<clientId>","state":"conflict","reason":"<writer reason>"}` |
| 409 | restore returns `reason: "drift_requires_confirm"` | `{"error":"restore requires drift confirmation","code":"integration_drift_confirmation_required","clientId":"<clientId>","state":"<writer state>","reason":"drift_requires_confirm"}` |
| 410 | journal row exists but `readSnapshot(opId) === null` | `{"error":"integration snapshot expired","code":"integration_snapshot_expired","opId":"<request opId>"}` |
| 413 | declared body exceeds outer 2 MiB cap, or decompressed body exceeds `readManagementJsonBody` 4 MiB cap | `{"error":"request body too large"}` |
| 500 | writer returns another `ok: false` result | `{"error":"integration mutation failed","code":"integration_mutation_failed","clientId":"<clientId>","state":"<writer state>","reason":"<writer reason>"}` |
| 500 | unexpected thrown error | `{"error":"<Error.message or String(error)>","code":"integration_internal_error"}` |

Management admission errors happen outside the new module and remain exact:

| Status | Trigger | Exact JSON body |
|---|---|---|
| 401 | missing/invalid admin token, or a GUI-session mutation missing/mismatching Origin, GUI-origin, or CSRF token | `{"error":"opencodex admin token required"}` |
| 403 | authenticated request rejected by management-origin policy | `{"error":"cross-origin request blocked"}` |
| 503 | management auth state unavailable | `{"error":"management API unavailable","reason":"<state reason>","hint":"Set OPENCODEX_ADMIN_AUTH_TOKEN to bypass file-backed admin token ACL hardening"}` |

Unsupported methods and deeper paths return `null` from the module. The outer
server retains ownership of its existing unknown-endpoint 404 envelope.

## 4. New file — `src/server/management/integration-routes.ts`

Create the file with this complete content:

```ts
import {
  INTEGRATION_CLIENTS,
  type IntegrationClientId,
} from "../../integrations/registry";
import { listOperations, readSnapshot } from "../../integrations/journal";
import { readIntegrationState } from "../../integrations/state";
import {
  applyIntegration,
  disableIntegration,
  restoreIntegration,
} from "../../integrations/writer";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

const INTEGRATION_ROUTE_PREFIX = "/api/client-integrations/";
const INTEGRATION_MUTATION_JOIN_MS = 120_000;
export const INTEGRATION_MUTATION_TERMINAL_MS = 10 * 60_000;

type IntegrationStateRecord = Awaited<ReturnType<typeof readIntegrationState>>;
type IntegrationOperation = Awaited<ReturnType<typeof listOperations>>[number];
type ApplyResult = Awaited<ReturnType<typeof applyIntegration>>;
type DisableResult = Awaited<ReturnType<typeof disableIntegration>>;
type RestoreResult = Awaited<ReturnType<typeof restoreIntegration>>;

export type IntegrationStateEnvelope = {
  clientId: IntegrationClientId;
} & IntegrationStateRecord;

export interface IntegrationStateListEnvelope {
  clients: IntegrationStateEnvelope[];
}

export type IntegrationToggleEnvelope =
  | ({ clientId: IntegrationClientId } & ApplyResult)
  | ({ clientId: IntegrationClientId } & DisableResult);

export type IntegrationRestoreEnvelope = {
  clientId: IntegrationClientId;
} & RestoreResult;

export interface IntegrationJournalEnvelope {
  operations: IntegrationOperation[];
}

export interface IntegrationToggleBody {
  enabled: boolean;
}

export interface IntegrationRestoreBody {
  opId: string;
  confirmDrift?: boolean;
}

interface IntegrationMutationFlight {
  key: string;
  startedAt: number;
  promise: Promise<unknown>;
}

class IntegrationMutationBusyError extends Error {
  constructor(readonly clientId: IntegrationClientId) {
    super("integration_mutation_busy");
  }
}

const integrationMutationFlights = new Map<IntegrationClientId, IntegrationMutationFlight>();
let integrationMutationTestHooks: {
  now?: () => number;
  run?: (operation: () => Promise<unknown>) => Promise<unknown>;
} | null = null;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegrationClientId(value: string | null): value is IntegrationClientId {
  return value !== null && INTEGRATION_CLIENTS.includes(value as IntegrationClientId);
}

function decodeClientPath(pathname: string): string | null {
  if (!pathname.startsWith(INTEGRATION_ROUTE_PREFIX)) return null;
  const encoded = pathname.slice(INTEGRATION_ROUTE_PREFIX.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function runIntegrationMutationFlight<T>(
  clientId: IntegrationClientId,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const now = integrationMutationTestHooks?.now?.() ?? Date.now();
  const current = integrationMutationFlights.get(clientId);
  if (current) {
    const age = now - current.startedAt;
    if (current.key === key && age < INTEGRATION_MUTATION_JOIN_MS) {
      return current.promise as Promise<T>;
    }
    if (age <= INTEGRATION_MUTATION_TERMINAL_MS) {
      return Promise.reject(new IntegrationMutationBusyError(clientId));
    }
    if (integrationMutationFlights.get(clientId) === current) {
      integrationMutationFlights.delete(clientId);
    }
  }

  const flight: IntegrationMutationFlight = {
    key,
    startedAt: now,
    promise: Promise.resolve(),
  };
  const run = async (): Promise<unknown> => operation();
  flight.promise = (integrationMutationTestHooks?.run
    ? integrationMutationTestHooks.run(run)
    : run()
  ).finally(() => {
    if (integrationMutationFlights.get(clientId) === flight) {
      integrationMutationFlights.delete(clientId);
    }
  });
  integrationMutationFlights.set(clientId, flight);
  return flight.promise as Promise<T>;
}

export function setIntegrationMutationFlightTestHooks(
  hooks: {
    now?: () => number;
    run?: (operation: () => Promise<unknown>) => Promise<unknown>;
  } | null,
): void {
  integrationMutationTestHooks = hooks;
  integrationMutationFlights.clear();
}

function invalidClientResponse(ctx: ManagementContext): Response {
  return jsonResponse({
    error: "invalid integration client",
    code: "invalid_integration_client",
    validClients: INTEGRATION_CLIENTS,
  }, 400, ctx.req, ctx.config);
}

function internalErrorResponse(error: unknown, ctx: ManagementContext): Response {
  return jsonResponse({
    error: error instanceof Error ? error.message : String(error),
    code: "integration_internal_error",
  }, 500, ctx.req, ctx.config);
}

async function readJsonBody(ctx: ManagementContext): Promise<unknown | Response> {
  try {
    return await readManagementJsonBody(ctx.req);
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    return jsonResponse({
      error: "invalid JSON body",
      code: "invalid_json_body",
    }, 400, ctx.req, ctx.config);
  }
}

function writerFailureResponse(
  clientId: IntegrationClientId,
  result: { state: string; reason?: string },
  ctx: ManagementContext,
): Response {
  const reason = result.reason ?? "unknown";
  if (result.state === "unsafe") {
    return jsonResponse({
      error: "integration config is unsafe",
      code: "integration_unsafe",
      clientId,
      state: "unsafe",
      reason,
    }, 409, ctx.req, ctx.config);
  }
  if (result.state === "conflict") {
    return jsonResponse({
      error: "integration config conflicts with ownership record",
      code: "integration_conflict",
      clientId,
      state: "conflict",
      reason,
    }, 409, ctx.req, ctx.config);
  }
  return jsonResponse({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId,
    state: result.state,
    reason,
  }, 500, ctx.req, ctx.config);
}

export async function handleIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;

  if (url.pathname === "/api/client-integrations" && req.method === "GET") {
    try {
      const clients = await Promise.all(INTEGRATION_CLIENTS.map(async clientId => ({
        clientId,
        ...await readIntegrationState(clientId, ctx),
      })));
      return jsonResponse({ clients } satisfies IntegrationStateListEnvelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/journal") {
    if (req.method !== "GET") return null;
    const requestedClient = url.searchParams.get("client");
    if (requestedClient !== null && !isIntegrationClientId(requestedClient)) {
      return invalidClientResponse(ctx);
    }
    try {
      const operations = await listOperations(requestedClient ?? undefined);
      return jsonResponse({ operations } satisfies IntegrationJournalEnvelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  if (url.pathname === "/api/client-integrations/restore") {
    if (req.method !== "POST") return null;
    const parsed = await readJsonBody(ctx);
    if (parsed instanceof Response) return parsed;
    if (!isPlainRecord(parsed) || typeof parsed.opId !== "string" || parsed.opId.trim().length === 0) {
      return jsonResponse({
        error: "opId must be a non-empty string",
        code: "invalid_op_id",
      }, 400, req, ctx.config);
    }
    if (parsed.confirmDrift !== undefined && typeof parsed.confirmDrift !== "boolean") {
      return jsonResponse({
        error: "confirmDrift must be a boolean",
        code: "invalid_confirm_drift",
      }, 400, req, ctx.config);
    }

    const opId = parsed.opId.trim();
    const confirmDrift = parsed.confirmDrift ?? false;
    try {
      const operation = (await listOperations()).find(entry => entry.opId === opId);
      if (!operation) {
        return jsonResponse({
          error: "integration operation not found",
          code: "integration_operation_not_found",
          opId,
        }, 404, req, ctx.config);
      }
      const snapshot = await readSnapshot(opId);
      if (snapshot === null) {
        return jsonResponse({
          error: "integration snapshot expired",
          code: "integration_snapshot_expired",
          opId,
        }, 410, req, ctx.config);
      }

      const result = await runIntegrationMutationFlight(
        operation.clientId,
        `restore:${opId}:${confirmDrift}`,
        () => Promise.resolve(restoreIntegration(opId, { confirmDrift })),
      );
      if (!result.ok) {
        if (result.reason === "drift_requires_confirm") {
          return jsonResponse({
            error: "restore requires drift confirmation",
            code: "integration_drift_confirmation_required",
            clientId: operation.clientId,
            state: result.state,
            reason: result.reason,
          }, 409, req, ctx.config);
        }
        return writerFailureResponse(operation.clientId, result, ctx);
      }
      return jsonResponse({ clientId: operation.clientId, ...result } satisfies IntegrationRestoreEnvelope, 200, req, ctx.config);
    } catch (error) {
      if (error instanceof IntegrationMutationBusyError) {
        return jsonResponse({
          error: "integration mutation busy",
          code: "integration_mutation_busy",
          clientId: error.clientId,
        }, 409, req, ctx.config);
      }
      return internalErrorResponse(error, ctx);
    }
  }

  if (req.method !== "GET" && req.method !== "PUT") return null;
  const requestedClient = decodeClientPath(url.pathname);
  if (requestedClient === null) return null;
  if (!isIntegrationClientId(requestedClient)) return invalidClientResponse(ctx);

  if (req.method === "GET") {
    try {
      const state = await readIntegrationState(requestedClient, ctx);
      return jsonResponse({ clientId: requestedClient, ...state } satisfies IntegrationStateEnvelope, 200, req, ctx.config);
    } catch (error) {
      return internalErrorResponse(error, ctx);
    }
  }

  const parsed = await readJsonBody(ctx);
  if (parsed instanceof Response) return parsed;
  if (!isPlainRecord(parsed) || typeof parsed.enabled !== "boolean") {
    return jsonResponse({
      error: "enabled must be a boolean",
      code: "invalid_enabled",
    }, 400, req, ctx.config);
  }

  try {
    const result = await runIntegrationMutationFlight(
      requestedClient,
      parsed.enabled ? "apply" : "disable",
      () => Promise.resolve(parsed.enabled
        ? applyIntegration(requestedClient, ctx)
        : disableIntegration(requestedClient)),
    );
    if (!result.ok) return writerFailureResponse(requestedClient, result, ctx);
    return jsonResponse({ clientId: requestedClient, ...result } satisfies IntegrationToggleEnvelope, 200, req, ctx.config);
  } catch (error) {
    if (error instanceof IntegrationMutationBusyError) {
      return jsonResponse({
        error: "integration mutation busy",
        code: "integration_mutation_busy",
        clientId: error.clientId,
      }, 409, req, ctx.config);
    }
    return internalErrorResponse(error, ctx);
  }
}
```

### 4.1 Single-flight semantics

- Flights are keyed by client, so different client files may mutate in
  parallel while apply/disable/restore for the same client cannot race.
- An identical request joins its existing promise for the first 120 seconds.
- A different mutation for the same client is immediately busy; an identical
  request older than 120 seconds is also busy through 10 minutes.
- A flight older than 10 minutes is replaced. Its eventual `finally` is
  identity-checked and cannot clear the replacement.
- The map is bounded by `INTEGRATION_CLIENTS.length`; the test hook clears all
  entries between tests.

## 5. Exact `src/server/management-api.ts` diff

Add the import after the other management route imports:

```diff
 import { handleSystemRoutes } from "./management/system-routes";
 import { handleSidebarRoutes } from "./management/sidebar-routes";
+import { handleIntegrationRoutes } from "./management/integration-routes";
 import type { ManagementContext } from "./management/context";
```

Insert the handler after model routes and before agent-specific settings. This
keeps generic model/export reads ahead of the new integration resource and
keeps the established Claude/Grok routes unchanged:

```diff
     ??     (await handleProviderRoutes(ctx))
     ??     (await handleModelRoutes(ctx))
+    ??     (await handleIntegrationRoutes(ctx))
     ??     (await handleAgentSettingsRoutes(ctx))
     ??     (await handleOauthAccountRoutes(ctx))
```

Do not alter auth, origin, declared body-size, decompressed-body error mapping,
or unknown-route handling in `handleManagementAPI`.

## 6. Activation scenarios — C-ACTIVATION-GROUNDING-01

Each refusal branch needs a fixture that would produce a materially different
result if the branch did not run.

| Branch | Test activation | Observable proof |
|---|---|---|
| busy 409 | Install a `setIntegrationMutationFlightTestHooks` runner whose first `pi` apply promise remains pending. Advance the injected clock past 120 seconds but not 10 minutes, then issue the same apply again. | Second response is exactly 409 `integration_mutation_busy`; writer call count remains one; resolving the first promise produces its original response and clears the flight. |
| invalid client 400 | Request both `GET /api/client-integrations/zed` and `GET /api/client-integrations/journal?client=zed`. | Both bodies equal the exact `invalid_integration_client` envelope and enumerate all six registry ids in registry order; no state/journal mutation occurs. |
| drift-requires-confirm 409 | Create an operation snapshot, modify the target after that operation, and restore with omitted/false `confirmDrift`. | Response is exactly 409 `integration_drift_confirmation_required`; target bytes remain the drifted bytes; journal count does not gain a restore operation. A second request with `confirmDrift: true` succeeds, preserves the drifted current file as the restore operation's new pre-write snapshot, and changes target bytes to the chosen snapshot. |
| unsafe refusal | Point a client config path at a directory (or the WP2 unsafe fixture), confirm GET reports `state: "unsafe"`, then PUT either toggle direction. | Mutation response is exactly 409 `integration_unsafe`; directory/file bytes and journal length are unchanged. |
| conflict refusal | Apply a managed config, edit its on-disk bytes so the persisted fingerprint no longer matches, then PUT `{ "enabled": false }`. | Response is exactly 409 `integration_conflict`; the edited provider block remains byte-for-byte present; no disable operation is appended. |
| journal-expired 410 | Produce 11 operations for one client so WP3's 10-snapshot GC collects the first snapshot while retaining its immutable history row; restore the first `opId`. | Journal GET still contains the first row; restore returns exactly 410 `integration_snapshot_expired`; target bytes and journal length are unchanged. |

## 7. New test file — `tests/management-integration-routes.test.ts`

Use `bun:test`, `mkdtempSync(join(tmpdir(), "ocx-management-integrations-"))`,
and `rmSync(..., { recursive: true, force: true })` cleanup, matching
`tests/management-client-config-route.test.ts`. Isolate every client path and
the opencodex journal root through the WP1-WP3 environment/path seams. Restore
all environment variables and call
`setIntegrationMutationFlightTestHooks(null)` in `afterEach`.

The file contains these exact test names:

1. `GET /api/client-integrations lists all registry clients in registry order`
   - status 200; ids exactly equal `INTEGRATION_CLIENTS`; each item equals
     `{ clientId, ...readIntegrationState(clientId, ctx) }`; fingerprints and
     `configPath` are present; no snapshot bytes appear in serialized JSON.
2. `GET /api/client-integrations/:clientId returns one five-state record`
   - create a current fixture; status 200; exact `clientId`, `state`,
     fingerprints, and `configPath`; no writer/journal change.
3. `unknown path and journal clients return the exact 400 registry envelope`
   - activates both invalid-client entry points and checks exact body equality,
     including the six valid ids.
4. `PUT /api/client-integrations/:clientId applies and disables through the writer`
   - apply from absent and disable from current; both status 200; response
     preserves `ok`, `changed`, `state`, `opId`, and `reason`; state read-back
     changes as expected; two immutable journal rows exist.
5. `duplicate apply joins for 120 seconds and an older flight returns busy 409`
   - uses the test hook and clock; proves one underlying run for joined calls,
     then the exact busy envelope after the join window; resolves the pending
     promise in `finally` so the suite cannot leak a flight.
6. `conflict refuses disable without changing foreign-edited bytes`
   - required conflict-refuses-disable case from §6; exact 409 envelope,
     byte equality before/after, and unchanged journal count.
7. `unsafe state is readable but toggle mutation is refused`
   - GET is 200 with `unsafe`; PUT is exact 409 `integration_unsafe`; no bytes
     or journal row change.
8. `restore requires explicit drift confirmation and preserves current bytes before overwrite`
   - false/omitted confirm returns exact 409 and no write; true confirm returns
     200, restores selected bytes, and creates a new snapshot containing the
     drifted pre-restore bytes.
9. `restore distinguishes an unknown operation from an expired snapshot`
   - unknown id is exact 404; GC-retained history with missing snapshot is
     exact 410; neither path mutates target or journal.
10. `GET /api/client-integrations/journal returns newest-first metadata and filters by client`
    - unfiltered order equals `listOperations()`; filtered order equals
      `listOperations(clientId)`; response text contains no snapshot content
      or serialized secret fixture.
11. `mutation bodies reject malformed JSON invalid fields and decompressed overflow`
    - exact 400 envelopes for malformed JSON, non-boolean `enabled`, blank
      `opId`, and non-boolean `confirmDrift`; a compressed body over the bounded
      reader limit bubbles to the outer exact 413 body.
12. `GUI-session mutation without CSRF is rejected before integration dispatch`
    - create `initializeManagementAuthState`, mint a same-origin GUI session,
      and pass a same-origin PUT carrying the session token and GUI-origin but
      no `X-OpenCodex-CSRF-Token` through the same
      `requireManagementAuth -> handleManagementAPI` sequence used by
      `src/server/index.ts`; assert exact 401 body, target absent, journal
      empty. Add the CSRF header in the control request and assert admission
      succeeds and the route returns 200. Do not add an auth call to the route
      module to make this test pass.
13. `authenticated cross-origin state read keeps the management 403 envelope`
    - admin-authenticated request with a mismatched `Origin` reaches
      `handleManagementAPI` and is rejected with exact 403
      `cross-origin request blocked` before state reading.

For the direct route helper, follow the existing convention:

```ts
const response = await handleManagementAPI(
  new Request(url, init),
  url,
  config,
  { saveConfigPreservingClaudeCode: () => {}, refreshCodexCatalog: async () => {} },
);
expect(response).not.toBeNull();
```

Do not stub the WP2/WP3 state machine in conflict, unsafe, restore, or GC
tests. Those tests must trigger the real filesystem/journal condition so a
status-only fake cannot make a non-activated branch look covered.

## 8. Mechanical acceptance criteria

- [ ] `src/server/management/integration-routes.ts` exists with the §4 content
  and imports only the agreed WP1-WP3 modules plus existing management helpers.
- [ ] `src/server/management-api.ts` has exactly one new import and one new
  `??` chain entry in the §5 positions.
- [ ] No new route module calls `requireManagementAuth`; the CSRF test proves
  admission happens before dispatch.
- [ ] The collection route returns all and only the six
  `INTEGRATION_CLIENTS`, in registry order.
- [ ] Single-client and journal-filter validation share the exact 400 envelope.
- [ ] GET returns `unsafe` as state with 200; mutating unsafe returns exact 409.
- [ ] Disable from `conflict` returns exact 409 and does not alter bytes or
  append an operation.
- [ ] Restore distinguishes unknown operation (404), drift confirmation (409),
  and collected snapshot (410).
- [ ] Confirmed drift restore snapshots current bytes before replacement and is
  itself undoable.
- [ ] Journal responses contain operation metadata only and never snapshot
  bytes or secret fixture text.
- [ ] Same-client mutation flights join only identical requests inside 120
  seconds, return busy through 10 minutes, and replace stale flights safely.
- [ ] Unsupported methods/deeper paths return `null` from the module.
- [ ] Malformed JSON is 400; decompressed overflow rethrows through
  `rethrowManagementBodyTooLarge` and is mapped to the existing exact 413.
- [ ] `bun test tests/management-integration-routes.test.ts` exits 0.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `bun run privacy:scan` exits 0; route/journal responses contain no API
  key, account identifier, or snapshot content.
- [ ] `git diff --check` exits 0.
- [ ] `git diff --name-only` for WP4 lists only the three IN-scope files from
  §1.1.
