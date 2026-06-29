import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectKiroCliSqlite, loginKiro, readKiroCliSqlite, refreshKiroToken, resolveKiroProfileArn, resolveKiroRegion } from "../src/oauth/kiro";

const origHome = process.env.HOME;
const origEnvTok = process.env.KIRO_ACCESS_TOKEN;
const origArn = process.env.KIRO_PROFILE_ARN;
const origRegion = process.env.KIRO_REGION;
const origFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-oauth-"));
  process.env.HOME = tmp;
  delete process.env.KIRO_ACCESS_TOKEN;
  delete process.env.KIRO_PROFILE_ARN;
  delete process.env.KIRO_REGION;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origEnvTok === undefined) delete process.env.KIRO_ACCESS_TOKEN;
  else process.env.KIRO_ACCESS_TOKEN = origEnvTok;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN;
  else process.env.KIRO_PROFILE_ARN = origArn;
  if (origRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = origRegion;
  globalThis.fetch = origFetch;
  rmSync(tmp, { recursive: true, force: true });
});

function seedKiroCliDb(token: { access_token: string; refresh_token?: string; expires_at?: string; profile_arn?: string }) {
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
    expect(cred.source).toBe("local-cli");
  });

  test("loginKiro falls back to KIRO_ACCESS_TOKEN env when no SQLite token", async () => {
    process.env.KIRO_ACCESS_TOKEN = "aoa-env";
    const cred = await loginKiro({});
    expect(cred.access).toBe("aoa-env");
    expect(cred.source).toBe("environment");
  });

  test("loginKiro uses manual paste (CLI) when no SQLite/env token", async () => {
    const cred = await loginKiro({ onManualCodeInput: async () => "  aoa-pasted  " });
    expect(cred.access).toBe("aoa-pasted");
    expect(cred.source).toBe("manual");
  });

  test("loginKiro throws (not hangs) in GUI with no token and no manual input", async () => {
    await expect(loginKiro({})).rejects.toThrow(/no token found/i);
  });

  test("inspectKiroCliSqlite reports safe diagnostics without token values", () => {
    seedKiroCliDb({ access_token: "aoa-diagnostic-secret", refresh_token: "rt-diagnostic-secret" });

    const result = inspectKiroCliSqlite();
    const rendered = JSON.stringify(result.diagnostics);

    expect(result.token?.access).toBe("aoa-diagnostic-secret");
    expect(result.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "token_found" });
    expect(rendered).not.toContain("aoa-diagnostic-secret");
    expect(rendered).not.toContain("rt-diagnostic-secret");
    expect(rendered).not.toContain(tmp);
  });

  test("inspectKiroCliSqlite distinguishes schema mismatch from no token", () => {
    const dir = join(tmp, "Library", "Application Support", "kiro-cli");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "data.sqlite3"));
    db.run("CREATE TABLE other_table (key TEXT PRIMARY KEY, value TEXT)");
    db.close();

    const result = inspectKiroCliSqlite();

    expect(result.token).toBeNull();
    expect(result.diagnostics).toContainEqual({ location: "kiro-cli-data", status: "schema_mismatch" });
    expect(result.diagnostics).toContainEqual({ location: "kiro-sso-cache", status: "missing" });
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

describe("kiro oauth — adapter-time resolvers (profileArn / region)", () => {
  test("resolveKiroProfileArn: KIRO_PROFILE_ARN env wins over SQLite", () => {
    process.env.KIRO_PROFILE_ARN = "arn:env";
    seedKiroCliDb({ access_token: "aoa", profile_arn: "arn:sqlite" });
    expect(resolveKiroProfileArn()).toBe("arn:env");
  });

  test("resolveKiroProfileArn: reads profile_arn from SQLite when env unset", () => {
    seedKiroCliDb({ access_token: "aoa", profile_arn: "arn:sqlite" });
    expect(resolveKiroProfileArn()).toBe("arn:sqlite");
  });

  test("resolveKiroProfileArn: undefined when no env and no SQLite", () => {
    expect(resolveKiroProfileArn()).toBeUndefined();
  });

  test("resolveKiroRegion: KIRO_REGION override, else us-east-1 default", () => {
    expect(resolveKiroRegion()).toBe("us-east-1");
    process.env.KIRO_REGION = "eu-west-1";
    expect(resolveKiroRegion()).toBe("eu-west-1");
  });
});
