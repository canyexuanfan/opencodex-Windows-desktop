import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_REAUTH_ACTION,
  collectOAuthHealthEntries,
  projectOAuthAccountHealth,
} from "../src/oauth/health";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../src/oauth/store";
import {
  clearAccountNeedsReauth,
  markAccountNeedsReauth as markCodexAccountNeedsReauth,
} from "../src/codex/account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import {
  clearCodexUpstreamHealth,
  getCodexAccountHealthSnapshot,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import type { OcxConfig } from "../src/types";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-health-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  clearCodexUpstreamHealth();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  clearCodexUpstreamHealth();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  rmSync(tmp, { recursive: true, force: true });
});

describe("projectOAuthAccountHealth", () => {
  test("reauth beats cooldown", () => {
    expect(projectOAuthAccountHealth({
      needsReauth: true,
      reauthReason: "refresh_failed",
      cooldownUntilMs: Date.now() + 60_000,
    })).toEqual({ status: "reauth_required", reason: "refresh_failed" });
  });

  test("active cooldown projects until ISO timestamp", () => {
    const until = Date.parse("2026-07-23T14:30:00.000Z");
    expect(projectOAuthAccountHealth({
      cooldownUntilMs: until,
      cooldownReason: "rate_limit",
      now: until - 1000,
    })).toEqual({
      status: "cooldown",
      until: "2026-07-23T14:30:00.000Z",
      reason: "rate_limit",
    });
  });

  test("cooldown beats warning, warning beats healthy", () => {
    const until = Date.now() + 60_000;
    expect(projectOAuthAccountHealth({
      cooldownUntilMs: until,
      cooldownReason: "quota",
      warningReason: "refresh_conflict",
      now: until - 1,
    })).toEqual({
      status: "cooldown",
      until: new Date(until).toISOString(),
      reason: "quota",
    });
    expect(projectOAuthAccountHealth({
      warningReason: "metadata_mismatch",
    })).toEqual({ status: "warning", reason: "metadata_mismatch" });
    expect(projectOAuthAccountHealth({})).toEqual({ status: "healthy" });
  });

  test("expired cooldown is healthy", () => {
    const until = Date.parse("2026-07-23T14:30:00.000Z");
    expect(projectOAuthAccountHealth({
      cooldownUntilMs: until,
      cooldownReason: "rate_limit",
      now: until,
    })).toEqual({ status: "healthy" });
  });
});

describe("collectOAuthHealthEntries", () => {
  test("projects needsReauth account with reauth action", async () => {
    await saveCredential("kimi", {
      access: "kimi-access",
      refresh: "kimi-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "kimi-acct-1",
    });
    const accountId = getAccountSet("kimi")!.activeAccountId;
    await markAccountNeedsReauth("kimi", accountId, true);

    const entries = collectOAuthHealthEntries();
    const entry = entries.find(e => e.provider === "kimi" && e.accountId === accountId);
    expect(entry).toEqual({
      provider: "kimi",
      accountId,
      health: { status: "reauth_required", reason: "refresh_failed" },
      action: "run `ocx login kimi`",
    });
  });

  test("Codex reauth action points at the dashboard pool, not ocx login codex", () => {
    markCodexAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    const entries = collectOAuthHealthEntries();
    const entry = entries.find(e => e.provider === "codex" && e.accountId === MAIN_CODEX_ACCOUNT_ID);
    expect(entry).toEqual({
      provider: "codex",
      accountId: MAIN_CODEX_ACCOUNT_ID,
      health: { status: "reauth_required", reason: "refresh_failed" },
      action: CODEX_REAUTH_ACTION,
    });
    expect(entry!.action).not.toContain("ocx login codex");
  });
});

describe("getCodexAccountHealthSnapshot", () => {
  test("exposes active cooldown source without changing write policy", () => {
    const config = { providers: {} } as OcxConfig;
    const now = Date.parse("2026-07-23T14:00:00.000Z");
    recordCodexUpstreamOutcome(config, "pool-acct", 429, { retryAfter: "120", now });

    expect(getCodexAccountHealthSnapshot("pool-acct", now)).toEqual({
      cooldownUntil: now + 120_000,
      cooldownSource: "retry-after",
    });
    expect(getCodexAccountHealthSnapshot("missing", now)).toBeNull();
  });
});
