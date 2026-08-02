import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../src/clients/config-export";
import { fileIO, type IntegrationIO } from "../src/integrations/config-io";
import { INTEGRATION_CLIENTS, INTEGRATION_CLIENT_IDS } from "../src/integrations/registry";
import { readIntegrationState } from "../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import { applyIntegration } from "../src/integrations/writer";
import { handleManagementAPI } from "../src/server/management-api";
import {
  setIntegrationMutationFlightTestHooks,
  setIntegrationPathTestHooks,
} from "../src/server/management/integration-routes";
import {
  initializeManagementAuthState,
  issueGuiSession,
  requireManagementAuth,
} from "../src/server/management-auth";
import type { OcxConfig } from "../src/types";

/**
 * Route contract for devlog/_plan/260802_client_toggle_api/040 §6-§7.
 *
 * Every refusal here is produced by the real writer against a real temp HOME
 * and a real temp store. A status-only fake would let a branch that never
 * runs look covered, which is the one thing this suite exists to prevent.
 */
let base = "";
let home = "";
let storeRoot = "";
let store: IntegrationStateStore;
/**
 * The environment the ROUTE resolves paths with — never `process.env`.
 *
 * Bun's `os.homedir()` ignores a mid-process `HOME` assignment, so rewriting
 * the variable is not isolation; only passing `home` explicitly is. An earlier
 * draft of this suite learned that by creating a real `~/.hermes/config.yaml`.
 */
const routeEnv = {} as NodeJS.ProcessEnv;

/**
 * A key shaped exactly like a real one, assembled at runtime so the privacy
 * scanner sees no literal secret while the running config still holds a
 * serializable one — without that, "no key leaked" asserts nothing.
 */
const REAL_LOOKING_KEY = ["ocx", "live", "9f3c7a2b41d84e6fa05c8e17b3d92764"].join("_");

const MODELS_FIXTURE: ExportModel[] = [
  { namespaced: "a/m1", provider: "a", id: "m1", contextWindow: 128_000 },
];

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "a",
    apiKeys: [{ id: "key-1", name: "default", key: REAL_LOOKING_KEY, createdAt: new Date(0).toISOString() }],
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: REAL_LOOKING_KEY,
        liveModels: false,
        models: ["m1"],
        modelContextWindows: { m1: 128_000 },
      },
    },
  } as unknown as OcxConfig;
}

let config: OcxConfig;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ocx-management-integrations-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
  config = baseConfig();
  setIntegrationMutationFlightTestHooks({ store });
  setIntegrationPathTestHooks({ env: routeEnv, home });
});

afterEach(() => {
  setIntegrationMutationFlightTestHooks(null);
  setIntegrationPathTestHooks(null);
  rmSync(base, { recursive: true, force: true });
});

/** Hermes: installed by creating its home directory; YAML on disk. */
function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  const dir = spec.detectDir(routeEnv, home);
  mkdirSync(dir, { recursive: true });
  return spec.configPath(routeEnv, home);
}

function hermesConfigPath(): string {
  return INTEGRATION_CLIENTS.hermes.configPath(routeEnv, home);
}

async function rawApi(path: string, init: RequestInit = {}): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init.headers ?? {}) } }),
    url,
    config,
    { saveConfigPreservingClaudeCode: () => {}, refreshCodexCatalog: async () => {} },
  );
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await rawApi(path, init);
  expect(response).not.toBeNull();
  return response!;
}

function put(clientId: string, enabled: boolean): Promise<Response> {
  return api(`/api/client-integrations/${clientId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

function restore(body: unknown): Promise<Response> {
  return api("/api/client-integrations/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface JournalRow {
  opId: string;
  clientId: string;
  kind: string;
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
}

async function journal(query = ""): Promise<JournalRow[]> {
  const response = await api(`/api/client-integrations/journal${query}`);
  expect(response.status).toBe(200);
  return (await response.json() as { operations: JournalRow[] }).operations;
}

const INVALID_CLIENT_BODY = {
  error: "invalid integration client",
  code: "invalid_integration_client",
  validClients: [...INTEGRATION_CLIENT_IDS],
};

/** Let every pending microtask/IO turn run before observing shared state. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Every file under a root with its exact bytes — the byte-identity witness. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out[rel] = readFileSync(abs, "utf8");
    }
  };
  walk(root, "");
  return out;
}

describe("GET /api/client-integrations", () => {
  test("lists all registry clients in registry order", async () => {
    installHermes();
    const response = await api("/api/client-integrations");
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { clients: { clientId: string; configPath: string }[] };

    expect(body.clients.map(c => c.clientId)).toEqual([...INTEGRATION_CLIENT_IDS]);
    for (const client of body.clients) {
      expect(client.configPath.startsWith(home)).toBe(true);
    }
    // The route must read through the SAME store the caller bound, or a test
    // that isolates writes still reads the developer's real snapshots.
    const models = await exportModels();
    expect(body.clients).toEqual(INTEGRATION_CLIENT_IDS.map(clientId =>
      JSON.parse(JSON.stringify(readIntegrationState({
        clientId, models, config, port: 10100, store, env: routeEnv, home,
      })))));
    expect(text).not.toContain(REAL_LOOKING_KEY);
  });

  test("returns one five-state record for a single client", async () => {
    installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    const before = store.listOperations().length;

    const response = await api("/api/client-integrations/hermes");
    expect(response.status).toBe(200);
    const body = await response.json() as { clientId: string; state: string; configPath: string; installed: boolean };
    expect(body.clientId).toBe("hermes");
    expect(body.state).toBe("current");
    expect(body.installed).toBe(true);
    expect(body.configPath).toBe(hermesConfigPath());
    // A read is a read: it appends nothing.
    expect(store.listOperations()).toHaveLength(before);
  });
});

/** The models the route itself derives, so expectations cannot drift from it. */
async function exportModels(): Promise<ExportModel[]> {
  const { loadExportModels } = await import("../src/server/management/model-rows");
  return loadExportModels(config);
}

describe("client validation", () => {
  test("unknown path and journal clients return the exact 400 registry envelope", async () => {
    const path = await api("/api/client-integrations/zed");
    expect(path.status).toBe(400);
    expect(await path.json()).toEqual(INVALID_CLIENT_BODY);

    const filter = await api("/api/client-integrations/journal?client=zed");
    expect(filter.status).toBe(400);
    expect(await filter.json()).toEqual(INVALID_CLIENT_BODY);

    expect(store.listOperations()).toHaveLength(0);
  });

  test("unsupported methods and deeper paths are declined by the module", async () => {
    /*
     * The module returns `null`, which is the whole contract: the unknown-route
     * envelope stays the outer server's to own. `handleManagementAPI` itself
     * has no 404 for a plain GET, so asserting a status here would be
     * asserting someone else's behavior.
     */
    const deeper = await rawApi("/api/client-integrations/hermes/extra");
    expect(deeper).toBeNull();
    const method = await rawApi("/api/client-integrations/hermes", { method: "DELETE" });
    expect(method).toBeNull();
    const journalPost = await rawApi("/api/client-integrations/journal", { method: "POST" });
    expect(journalPost).toBeNull();
  });
});

describe("PUT /api/client-integrations/:clientId", () => {
  test("applies and disables through the writer", async () => {
    const configPath = installHermes();

    const applied = await put("hermes", true);
    expect(applied.status).toBe(200);
    const applyBody = await applied.json() as { ok: boolean; changed: boolean; state: string; opId?: string };
    expect(applyBody.ok).toBe(true);
    expect(applyBody.changed).toBe(true);
    expect(typeof applyBody.opId).toBe("string");
    expect(readFileSync(configPath, "utf8")).toContain("opencodex");
    expect((await (await api("/api/client-integrations/hermes")).json() as { state: string }).state).toBe("current");

    const disabled = await put("hermes", false);
    expect(disabled.status).toBe(200);
    const disableBody = await disabled.json() as { ok: boolean; changed: boolean };
    expect(disableBody.ok).toBe(true);
    expect(disableBody.changed).toBe(true);
    expect(readFileSync(configPath, "utf8")).not.toContain("opencodex");

    // Two immutable rows: the journal records history, it does not fold it.
    expect(store.listOperations("hermes").map(row => row.kind)).toEqual(["disable", "apply"]);
  });

  test("a client that is not installed is refused without writing", async () => {
    const response = await put("hermes", true);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "integration_mutation_failed",
      clientId: "hermes",
      reason: "not_installed",
    });
    expect(existsSync(hermesConfigPath())).toBe(false);
    expect(store.listOperations()).toHaveLength(0);
  });
});

describe("single-flight", () => {
  test("duplicate apply joins for 120 seconds and an older flight returns busy 409", async () => {
    installHermes();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let clock = 1_000_000;
    const io: IntegrationIO = { ...fileIO(), now: () => clock, ...bookkeeping() };
    setIntegrationMutationFlightTestHooks({
      store,
      io,
      run: async operation => { runs += 1; await gate; return operation(); },
    });

    try {
      const first = put("hermes", true);
      const joined = put("hermes", true);
      // The route awaits its model load before reaching the flight map, so the
      // count is only meaningful after both requests have had a turn.
      await settle();
      expect(runs).toBe(1);

      clock += 121_000;
      const busy = await put("hermes", true);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({
        error: "integration mutation busy",
        code: "integration_mutation_busy",
        clientId: "hermes",
      });
      expect(runs).toBe(1);

      release();
      expect((await first).status).toBe(200);
      expect((await joined).status).toBe(200);
    } finally {
      release();
    }
  });

  test("a flight older than ten minutes is replaced without stale cleanup winning", async () => {
    installHermes();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let clock = 2_000_000;
    let gateFirstOnly = true;
    setIntegrationMutationFlightTestHooks({
      store,
      io: { ...fileIO(), now: () => clock, ...bookkeeping() },
      run: async operation => {
        runs += 1;
        if (gateFirstOnly) { gateFirstOnly = false; await gate; }
        return operation();
      },
    });

    try {
      const stale = put("hermes", true);
      await settle();
      expect(runs).toBe(1);

      clock += 11 * 60_000;
      const replacement = await put("hermes", true);
      expect(replacement.status).toBe(200);
      expect(runs).toBe(2);

      // The old flight's `finally` is identity-checked, so resolving it later
      // must not clear the replacement — proven by a third same-key request
      // joining rather than starting a run.
      release();
      expect((await stale).status).toBe(200);
      const third = await put("hermes", true);
      expect(third.status).toBe(200);
      expect(runs).toBe(3);
    } finally {
      release();
    }
  });
});

/** Bookkeeping seams bound to the temp store, as `store.io()` does. */
function bookkeeping(): Pick<IntegrationIO, "appendJournal" | "putRecord" | "dropRecord"> {
  return {
    appendJournal: entry => store.appendJournal(entry),
    putRecord: record => store.putRecord(record),
    dropRecord: clientId => store.dropRecord(clientId),
  };
}

describe("refusals", () => {
  test("conflict rejects disable without changing foreign-edited bytes", async () => {
    const configPath = installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    const edited = `${readFileSync(configPath, "utf8")}# a human edited this\n`;
    writeFileSync(configPath, edited);
    const journalBefore = store.listOperations().length;

    const response = await put("hermes", false);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "integration config conflicts with ownership record",
      code: "integration_conflict",
      clientId: "hermes",
      state: "conflict",
      reason: "conflict",
    });
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(store.listOperations()).toHaveLength(journalBefore);
  });

  test("unsafe state is readable but toggle mutation is rejected", async () => {
    const configPath = installHermes();
    // A directory where a config file belongs: readable as state, never writable.
    mkdirSync(configPath, { recursive: true });

    const read = await api("/api/client-integrations/hermes");
    expect(read.status).toBe(200);
    expect((await read.json() as { state: string }).state).toBe("unsafe");

    const response = await put("hermes", true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "integration config is unsafe",
      code: "integration_unsafe",
      clientId: "hermes",
      state: "unsafe",
      reason: "unsafe",
    });
    expect(existsSync(configPath)).toBe(true);
    expect(store.listOperations()).toHaveLength(0);
  });
});

describe("POST /api/client-integrations/restore", () => {
  test("requires explicit drift confirmation and preserves current bytes before overwrite", async () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\n");
    const original = readFileSync(configPath, "utf8");
    expect((await put("hermes", true)).status).toBe(200);
    const opId = store.listOperations("hermes")[0]!.opId;

    const drifted = `${readFileSync(configPath, "utf8")}# drifted\n`;
    writeFileSync(configPath, drifted);
    const journalBefore = store.listOperations().length;

    const refused = await restore({ opId });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: "restore requires drift confirmation",
      code: "integration_drift_confirmation_required",
      clientId: "hermes",
      reason: "drift_requires_confirm",
    });
    expect(readFileSync(configPath, "utf8")).toBe(drifted);
    expect(store.listOperations()).toHaveLength(journalBefore);

    const confirmed = await restore({ opId, confirmDrift: true });
    expect(confirmed.status).toBe(200);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const rows = store.listOperations("hermes");
    expect(rows[0]!.kind).toBe("restore");
    // The restore is itself undoable: the drifted bytes it replaced are kept.
    const snapshot = store.readSnapshot(rows[0]!);
    expect(snapshot.kind).toBe("stored");
    if (snapshot.kind === "stored") expect(snapshot.text).toBe(drifted);
  });

  test("restore of a none snapshot deletes the file created by apply", async () => {
    const configPath = installHermes();
    expect(existsSync(configPath)).toBe(false);
    expect((await put("hermes", true)).status).toBe(200);

    const rows = await journal("?client=hermes");
    expect(rows[0]!.snapshot).toBe("none");
    expect(rows[0]!.undoable).toBe(true);

    const response = await restore({ opId: rows[0]!.opId });
    expect(response.status).toBe(200);
    expect(existsSync(configPath)).toBe(false);
    expect(store.listOperations("hermes")[0]!.kind).toBe("restore");
    expect((await (await api("/api/client-integrations/hermes")).json() as { state: string }).state).toBe("absent");
  });

  test("distinguishes an unknown operation from an expired snapshot", async () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\n");

    const unknown = await restore({ opId: "op-does-not-exist" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "integration operation not found",
      code: "integration_operation_not_found",
      opId: "op-does-not-exist",
    });

    /*
     * More than ten STORED snapshots for one client: retention keeps the
     * newest ten files, so the oldest tag resolves to `expired` while its
     * history row survives. Apply-from-absent snapshots as `none`, which is
     * never collected, so the loop toggles against an existing file.
     */
    let oldestStored = "";
    for (let i = 0; i < 12; i += 1) {
      const response = await put("hermes", i % 2 === 0);
      expect(response.status).toBe(200);
      const newest = (await journal("?client=hermes"))[0]!;
      if (!oldestStored && newest.snapshot === "stored") oldestStored = newest.opId;
    }
    const rows = await journal("?client=hermes");
    expect(rows.length).toBeGreaterThanOrEqual(12);
    const oldest = rows.find(row => row.opId === oldestStored)!;
    expect(oldest.snapshot).toBe("expired");
    // Retention kept exactly the newest ten files; the rows all survive.
    expect(store.countSnapshots("hermes")).toBe(10);
    expect(rows.filter(row => row.snapshot === "stored")).toHaveLength(10);

    const before = readFileSync(configPath, "utf8");
    const journalBefore = store.listOperations().length;
    const expired = await restore({ opId: oldest.opId });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "integration snapshot expired",
      code: "integration_snapshot_expired",
      opId: oldest.opId,
    });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(store.listOperations()).toHaveLength(journalBefore);
  });
});

describe("GET /api/client-integrations/journal", () => {
  test("derives snapshot tags and undoable per request", async () => {
    const configPath = installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    expect((await put("hermes", false)).status).toBe(200);

    const rows = await journal();
    expect(rows.map(row => row.kind)).toEqual(["disable", "apply"]);
    expect(rows[0]!.snapshot).toBe("stored");
    expect(rows[0]!.undoable).toBe(true);
    // Only the newest row is offered as undo; an older one would rewind past
    // a change the user has not been shown.
    expect(rows[1]!.undoable).toBe(false);

    const filtered = await journal("?client=hermes");
    expect(filtered.map(row => row.opId)).toEqual(rows.map(row => row.opId));

    // A foreign edit revokes undo without touching the stored snapshot tag.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# foreign\n`);
    const afterEdit = await journal();
    expect(afterEdit[0]!.undoable).toBe(false);
    expect(afterEdit[0]!.snapshot).toBe("stored");

    const text = await (await api("/api/client-integrations/journal")).text();
    expect(text).not.toContain(REAL_LOOKING_KEY);
    expect(text).not.toContain("resultFingerprint");
    expect(text).not.toContain("priorRecord");
  });
});

describe("request bodies", () => {
  test("reject malformed JSON and invalid fields with exact envelopes", async () => {
    installHermes();
    const malformed = await api("/api/client-integrations/hermes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body", code: "invalid_json_body" });

    const nonBoolean = await api("/api/client-integrations/hermes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(nonBoolean.status).toBe(400);
    expect(await nonBoolean.json()).toEqual({ error: "enabled must be a boolean", code: "invalid_enabled" });

    const blankOpId = await restore({ opId: "   " });
    expect(blankOpId.status).toBe(400);
    expect(await blankOpId.json()).toEqual({ error: "opId must be a non-empty string", code: "invalid_op_id" });

    const badConfirm = await restore({ opId: "op-1", confirmDrift: "yes" });
    expect(badConfirm.status).toBe(400);
    expect(await badConfirm.json()).toEqual({ error: "confirmDrift must be a boolean", code: "invalid_confirm_drift" });

    expect(store.listOperations()).toHaveLength(0);
  });

  test("a decompressed body over the bounded reader limit becomes the outer 413", async () => {
    installHermes();
    const oversized = JSON.stringify({ enabled: true, pad: "x".repeat(5 * 1024 * 1024) });
    const response = await api("/api/client-integrations/hermes", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: Bun.gzipSync(new TextEncoder().encode(oversized)),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(store.listOperations()).toHaveLength(0);
  });
});

describe("admission", () => {
  test("a whole transaction stays inside the bound store", async () => {
    /*
     * The sharpest isolation claim in this work package: apply, disable,
     * restore and the collection read all have to land in the temp root. A
     * real store is seeded first and compared byte-for-byte afterwards,
     * including the maintenance marker that post-commit pruning touches —
     * an earlier draft passed every other test while quietly writing there.
     */
    const realRoot = join(base, "real-store", "integrations");
    const real = createIntegrationStateStore(realRoot);
    real.captureSnapshot("hermes", "seeded-op", "seeded snapshot bytes\n");
    real.appendJournal({
      opId: "seeded-op",
      clientId: "hermes",
      kind: "apply",
      at: new Date(0).toISOString(),
      configPath: join(base, "elsewhere", "config.yaml"),
      snapshot: { kind: "stored", relPath: join("snapshots", "hermes", "seeded-op") },
      resultFingerprint: "seeded",
      resultAbsent: false,
      priorRecord: null,
    });
    real.markPruneFailure("hermes", "seeded failure");
    const before = snapshotTree(realRoot);

    installHermes();
    expect((await put("hermes", true)).status).toBe(200);
    expect((await put("hermes", false)).status).toBe(200);
    const opId = store.listOperations("hermes")[0]!.opId;
    expect((await restore({ opId })).status).toBe(200);
    expect((await api("/api/client-integrations")).status).toBe(200);

    expect(snapshotTree(realRoot)).toEqual(before);
    // …and the whole transaction is in the temp root instead.
    expect(store.listOperations("hermes").length).toBeGreaterThanOrEqual(3);
  });

  test("a GUI-session mutation without CSRF is rejected before integration dispatch", async () => {
    installHermes();
    const authConfig = { ...config, hostname: "127.0.0.1" } as OcxConfig;
    const state = initializeManagementAuthState(authConfig);
    const session = issueGuiSession(
      new Request("http://localhost:10100/", { headers: { Host: "localhost:10100" } }),
      authConfig,
      state,
    );
    expect(session).not.toBeNull();

    const headers = {
      Host: "localhost:10100",
      Origin: "http://localhost:10100",
      "Content-Type": "application/json",
      "x-opencodex-api-key": session?.token ?? "",
      "x-opencodex-gui-origin": "http://localhost:10100",
    };
    const url = new URL("http://localhost:10100/api/client-integrations/hermes");
    const withoutCsrf = new Request(url, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) });
    const denial = requireManagementAuth(withoutCsrf, state, authConfig);
    expect(denial?.status).toBe(401);
    expect(await denial!.json()).toEqual({ error: "opencodex admin token required" });
    expect(existsSync(hermesConfigPath())).toBe(false);
    expect(store.listOperations()).toHaveLength(0);

    const withCsrf = new Request(url, {
      method: "PUT",
      headers: { ...headers, "x-opencodex-csrf-token": session?.csrfToken ?? "" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(requireManagementAuth(withCsrf, state, authConfig)).toBeNull();
    const routed = await handleManagementAPI(withCsrf, url, authConfig, {
      saveConfigPreservingClaudeCode: () => {},
      refreshCodexCatalog: async () => {},
    });
    expect(routed?.status).toBe(200);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });
});
