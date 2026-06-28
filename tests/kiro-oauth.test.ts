import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginKiro, readKiroCliSqlite, refreshKiroToken } from "../src/oauth/kiro";

const origHome = process.env.HOME;
const origEnvTok = process.env.KIRO_ACCESS_TOKEN;
const origFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-oauth-"));
  process.env.HOME = tmp;
  delete process.env.KIRO_ACCESS_TOKEN;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origEnvTok === undefined) delete process.env.KIRO_ACCESS_TOKEN;
  else process.env.KIRO_ACCESS_TOKEN = origEnvTok;
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

describe("kiro oauth — import-first", () => {
  test("readKiroCliSqlite imports access+refresh from auth_kv", () => {
    seedKiroCliDb({ access_token: "aoa-abc", refresh_token: "rt-1", expires_at: "2099-01-01T00:00:00Z" });
    const t = readKiroCliSqlite();
    expect(t?.access).toBe("aoa-abc");
    expect(t?.refresh).toBe("rt-1");
    expect(t?.expires).toBe(new Date("2099-01-01T00:00:00Z").getTime());
  });

  test("loginKiro returns imported SQLite credentials", async () => {
    seedKiroCliDb({ access_token: "aoa-xyz", refresh_token: "rt-2" });
    const cred = await loginKiro({});
    expect(cred.access).toBe("aoa-xyz");
    expect(cred.refresh).toBe("rt-2");
  });

  test("loginKiro falls back to KIRO_ACCESS_TOKEN env when no SQLite token", async () => {
    process.env.KIRO_ACCESS_TOKEN = "aoa-env";
    const cred = await loginKiro({});
    expect(cred.access).toBe("aoa-env");
  });

  test("loginKiro uses manual paste (CLI) when no SQLite/env token", async () => {
    const cred = await loginKiro({ onManualCodeInput: async () => "  aoa-pasted  " });
    expect(cred.access).toBe("aoa-pasted");
  });

  test("loginKiro throws (not hangs) in GUI with no token and no manual input", async () => {
    await expect(loginKiro({})).rejects.toThrow(/no token found/i);
  });

  test("refreshKiroToken maps the desktop refresh response to credentials", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accessToken: "aoa-new", refreshToken: "rt-new", expiresIn: 1000 }), {
        status: 200,
      })) as typeof fetch;
    const before = Date.now();
    const cred = await refreshKiroToken("rt-old");
    expect(cred.access).toBe("aoa-new");
    expect(cred.refresh).toBe("rt-new");
    expect(cred.expires).toBeGreaterThanOrEqual(before + 1000 * 1000 - 50);
  });

  test("refreshKiroToken keeps old refresh token when server omits it", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accessToken: "aoa-new2", expiresIn: 60 }), { status: 200 })) as typeof fetch;
    const cred = await refreshKiroToken("rt-keep");
    expect(cred.refresh).toBe("rt-keep");
  });

  test("refreshKiroToken throws without a refresh token", async () => {
    await expect(refreshKiroToken("")).rejects.toThrow(/no refresh token/i);
  });
});
