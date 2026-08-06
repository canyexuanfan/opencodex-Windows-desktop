import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { setIntegrationEnabled } from "../src/codex/desired-state";
import type { ManagementApiDeps } from "../src/server/management/context";
import type { OcxConfig } from "../src/types";

let root = "";
let library = "";
let previousHome: string | undefined;
let previousLibrary: string | undefined;

function config(): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
  } as OcxConfig;
}

function persistedIntent(): unknown {
  const raw = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as { clientIntegrations?: Record<string, unknown> };
  return raw.clientIntegrations?.["claude-desktop"];
}

async function dispatch(path: string, init?: RequestInit, deps: ManagementApiDeps = {}, inputConfig: OcxConfig = config()) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(new Request(url, {
    ...init,
    headers: { Host: url.host, ...(init?.headers ?? {}) },
  }), url, inputConfig, deps);
}

async function toggle(enabled: boolean, deps: ManagementApiDeps = {}) {
  const response = await dispatch("/api/native-integrations/claude-desktop", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  }, deps);
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-toggle-"));
  library = join(root, "desktop-library");
  previousHome = process.env.OPENCODEX_HOME;
  previousLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousLibrary;
  rmSync(root, { recursive: true, force: true });
});

test("the native route advertises Claude Desktop and OFF persists intent before removal", async () => {
  let sawPersistedOff = false;
  const result = await toggle(false, {
    removeDesktop3pStandardPivot: () => {
      sawPersistedOff = persistedIntent() === false;
      return { ok: true, changed: false, kind: "noop", libraryPath: library };
    },
  });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ clientId: "claude-desktop", desiredEnabled: false });
  expect(sawPersistedOff).toBe(true);
  expect(persistedIntent()).toBe(false);

  const status = await dispatch("/api/native-integrations");
  const clients = (await status!.json() as { clients: Array<{ clientId: string }> }).clients;
  expect(clients.some(client => client.clientId === "claude-desktop")).toBe(true);
});

test("OFF on a missing or empty library is an idempotent no-op with no footprint", async () => {
  const missing = await toggle(false);
  expect(missing.body).toMatchObject({ ok: true, changed: false, desiredEnabled: false });
  expect(existsSync(library)).toBe(false);

  // A present-but-empty directory has no owned state and stays untouched too.
  const empty = join(root, "empty-library");
  mkdirSync(empty);
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = empty;
  const again = await toggle(false);
  expect(again.body).toMatchObject({ ok: true, changed: false, desiredEnabled: false });
  expect(existsSync(empty)).toBe(true);
  expect(existsSync(join(empty, "_meta.json"))).toBe(false);
});

test("post-commit unsafe and incomplete refusals disclose desired OFF without contents", async () => {
  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
  writeFileSync(join(root, "metadata-marker"), "");
  const unsafe = await toggle(false, {
    removeDesktop3pStandardPivot: () => ({ ok: false, changed: false, kind: "unsafe", libraryPath: library, reason: "metadata_unreadable" }),
  });
  expect(unsafe.status).toBe(409);
  expect(unsafe.body).toMatchObject({ reason: "metadata_unreadable", desiredEnabled: false });

  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
  const incomplete = await toggle(false, {
    removeDesktop3pStandardPivot: () => ({
      ok: false, changed: true, kind: "cleanup_incomplete", libraryPath: library, residualPaths: [join(library, "owned.json.bak")],
    }),
  });
  expect(incomplete.status).toBe(500);
  expect(incomplete.body).toMatchObject({
    reason: "cleanup_incomplete",
    desiredEnabled: false,
    residualPaths: [join(library, "owned.json.bak")],
  });
});

test("auto-apply re-reads desired state after catalog fetch and skips a concurrent OFF", async () => {
  const profile = {
    version: 1 as const,
    assignments: {},
    defaults: { opus: null, fable: null, sonnet: null, haiku: null },
  };
  const persisted = { ...config(), claudeCode: { desktopProfile: profile, injectAgents: false } };
  writeFileSync(join(root, "config.json"), JSON.stringify(persisted));
  writeFileSync(join(root, "config.json.bak"), JSON.stringify(persisted));
  writeFileSync(join(root, "config.json"), JSON.stringify(persisted));
  const id = "selected-owned";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(library);
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    // Shape-only value: deliberately inert; never a credential.
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret",
  }));
  let release!: () => void;
  let started!: () => void;
  const fetched = new Promise<never[]>(resolve => { release = () => resolve([]); });
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  let writes = 0;
  const request = dispatch("/api/subagent-models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: [] }),
  }, {
    fetchAllModels: () => {
      started();
      return fetched;
    },
    writeDesktop3pConfig: () => {
      writes++;
      return { written: true, path: join(library, "new.json"), fingerprint: "fingerprint" };
    },
  }, persisted);
  await fetchStarted;
  expect(setIntegrationEnabled("claude-desktop", false).ok).toBe(true);
  release();
  expect((await request)!.status).toBe(200);
  expect(writes).toBe(0);
});
