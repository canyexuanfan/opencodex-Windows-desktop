import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectOAuthDoctorChecks } from "../src/cli/doctor";
import {
  clearAccountNeedsReauth,
  markAccountNeedsReauth as markCodexAccountNeedsReauth,
} from "../src/codex/account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { CODEX_REAUTH_ACTION } from "../src/oauth/health";
import { getAccountSet, markAccountNeedsReauth, saveCredential } from "../src/oauth/store";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `doctor-oauth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = origOcxHome;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  rmSync(tmp, { recursive: true, force: true });
});

describe("collectOAuthDoctorChecks", () => {
  test("needsReauth account yields WARN with action and redacted id", async () => {
    await saveCredential("openai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_abcdefghijklmnopqrstuvwxyz",
      source: "oauth",
    });
    const set = getAccountSet("openai");
    expect(set).toBeTruthy();
    const accountId = set!.activeAccountId;
    await markAccountNeedsReauth("openai", accountId, true);

    const checks = await collectOAuthDoctorChecks();
    const warn = checks.find(
      (c) => c.level === "WARN" && c.message.includes("requires reauthentication"),
    );
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain("Action:");
    expect(warn!.message).toContain("ocx login openai");
    expect(warn!.message).toContain("account-…");
    expect(warn!.message).not.toContain(accountId);
    expect(warn!.message).not.toContain("access-token");
    expect(warn!.message).not.toContain("refresh-token");
  });

  test("emits static OK rows for storage, single-flight, and metadata", async () => {
    const checks = await collectOAuthDoctorChecks();
    expect(checks.some((c) => c.level === "OK" && c.message.includes("OAuth credential storage is writable"))).toBe(true);
    expect(checks.some((c) => c.level === "OK" && c.message.includes("Token refresh single-flight is active"))).toBe(true);
    expect(checks.some((c) => c.level === "OK" && c.message.includes("No fabricated official-client metadata detected"))).toBe(true);
  });

  test("Codex needsReauth WARN action points at the dashboard pool", async () => {
    markCodexAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
    // Force process-local Codex projection so a live proxy on the machine cannot mask this case.
    const checks = await collectOAuthDoctorChecks(Date.now(), {
      findLiveProxyImpl: async () => null,
    });
    const warn = checks.find(
      (c) => c.level === "WARN" && c.message.includes("requires reauthentication"),
    );
    expect(warn).toBeTruthy();
    expect(warn!.message).toContain(`Action: ${CODEX_REAUTH_ACTION}`);
    expect(warn!.message).not.toContain("ocx login codex");
  });

  test("every WARN includes a recovery Action", async () => {
    await saveCredential("xai", {
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_needs_reauth_suffix_42",
      source: "oauth",
    });
    const set = getAccountSet("xai")!;
    await markAccountNeedsReauth("xai", set.activeAccountId, true);

    const warns = (await collectOAuthDoctorChecks()).filter((c) => c.level === "WARN");
    expect(warns.length).toBeGreaterThan(0);
    for (const warn of warns) {
      expect(warn.message).toMatch(/Action:/);
    }
  });
});
