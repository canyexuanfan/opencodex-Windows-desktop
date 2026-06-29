import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessToken } from "../src/oauth";
import { getCredential, saveCredential } from "../src/oauth/store";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origRegion = process.env.KIRO_REGION;
const origFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  process.env.KIRO_REGION = "us-east-1";
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  globalThis.fetch = origFetch;
  rmSync(tmp, { recursive: true, force: true });
});

function seedKiroCliDb(token: { access_token: string; refresh_token?: string; expires_at?: string }) {
  const dir = join(tmp, "Library", "Application Support", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:social:token", JSON.stringify(token)]);
  db.close();
}

function mockRefreshFetch(responses: Array<Response | Error>): { count: () => number } {
  let calls = 0;
  let i = 0;
  globalThis.fetch = (async () => {
    calls++;
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { count: () => calls };
}

describe("oauth refresh hardening", () => {
  test("valid stored credential returns without refresh", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    saveCredential("kiro", { access: "aoa-valid", refresh: "rt", expires: Date.now() + 3600_000 });
    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-valid");
    expect(mock.count()).toBe(0);
  });

  test("concurrent expired Kiro refreshes share one request", async () => {
    const mock = mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    const [a, b] = await Promise.all([getValidAccessToken("kiro"), getValidAccessToken("kiro")]);
    expect(a).toBe("aoa-fresh");
    expect(b).toBe("aoa-fresh");
    expect(mock.count()).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-fresh");
  });

  test("fresh Kiro CLI SQLite token is imported before refresh endpoint", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    seedKiroCliDb({ access_token: "aoa-sqlite", refresh_token: "rt-sqlite", expires_at: "2099-01-01T00:00:00Z" });
    saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-sqlite");
    expect(mock.count()).toBe(0);
    expect(getCredential("kiro")?.refresh).toBe("rt-sqlite");
    expect(getCredential("kiro")?.source).toBe("local-cli");
  });

  test("failed refresh recovers from a now-fresh Kiro CLI SQLite token", async () => {
    saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      seedKiroCliDb({ access_token: "aoa-recovered", refresh_token: "rt-recovered", expires_at: "2099-01-01T00:00:00Z" });
      throw new Error("network down");
    }) as typeof fetch;

    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-recovered");
    expect(calls).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-recovered");
    expect(getCredential("kiro")?.source).toBe("local-cli");
  });

  test("refresh preserves existing credential source metadata", async () => {
    mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1, source: "manual" });

    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-fresh");
    expect(getCredential("kiro")?.source).toBe("manual");
  });
});
