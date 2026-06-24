import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_FAILURE_WINDOW_MS,
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  CODEX_THREAD_AFFINITY_MAX_ENTRIES,
  classifyCodexUpstreamOutcome,
  clearCodexUpstreamHealth,
  clearCodexUpstreamHealthForAccount,
  clearThreadAccountMap,
  clearThreadAccountMapForAccount,
  computeCodexUsageScore,
  getCodexAccountCooldownUntil,
  getCodexUpstreamHealth,
  isCodexAccountInCooldown,
  pickLowestUsageCodexAccount,
  parseRetryAfterMs,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
} from "../src/codex-routing";
import { removeCodexAccountCredential, saveCodexAccountCredential } from "../src/codex-account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  handleCodexAuthAPI,
  isAccountNeedsReauth,
  parseUsageQuota,
  updateAccountQuota,
} from "../src/codex-auth-api";
import { CODEX_UNKNOWN_USAGE_SCORE } from "../src/codex-quota";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-routing-test");
let previousOpencodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    ...overrides,
  } as OcxConfig;
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

describe("codex routing", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    clearAccountNeedsReauth("c");
    saveTestCredential("a");
    saveTestCredential("b");
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
    clearAccountNeedsReauth("c");
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("usage score uses the hottest known quota window", () => {
    expect(computeCodexUsageScore({ weeklyPercent: 15, fiveHourPercent: 81 })).toBe(81);
    expect(computeCodexUsageScore({ weeklyPercent: 15, fiveHourPercent: 20, monthlyPercent: 91 })).toBe(91);
    expect(computeCodexUsageScore({ weeklyPercent: 15 })).toBe(15);
  });

  test("usage score treats unknown quota conservatively", () => {
    expect(computeCodexUsageScore(null)).toBe(CODEX_UNKNOWN_USAGE_SCORE);
    expect(computeCodexUsageScore({})).toBe(CODEX_UNKNOWN_USAGE_SCORE);
  });

  test("5h threshold breach switches new threads even when weekly is low", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 85);
    updateAccountQuota("b", 20, 5);
    expect(resolveCodexAccountForThread("new-thread", config)).toBe("b");
  });

  test("unknown active quota can switch to a known lower usage account", () => {
    const config = makeConfig();
    updateAccountQuota("b", 20, 5);
    expect(resolveCodexAccountForThread("unknown-active", config)).toBe("b");
  });

  test("unknown quota does not beat known low quota during lowest-usage selection", () => {
    const config = makeConfig({
      codexAccounts: [
        { id: "a", email: "a@test", isMain: false },
        { id: "b", email: "b@test", isMain: false },
        { id: "c", email: "c@test", isMain: false },
      ],
    });
    saveTestCredential("c");
    updateAccountQuota("b", 25, 10);
    expect(pickLowestUsageCodexAccount(config)).toBe("b");
  });

  test("upstream outcome classifier separates caller, credential, and transient failures", () => {
    expect(classifyCodexUpstreamOutcome(200)).toBe("success");
    expect(classifyCodexUpstreamOutcome(401)).toBe("credential");
    expect(classifyCodexUpstreamOutcome(403)).toBe("credential");
    expect(classifyCodexUpstreamOutcome(429)).toBe("quota");
    expect(classifyCodexUpstreamOutcome(422)).toBe("caller");
    expect(classifyCodexUpstreamOutcome(503)).toBe("transient");
    expect(classifyCodexUpstreamOutcome("connect_error")).toBe("transient");
    expect(classifyCodexUpstreamOutcome("timeout")).toBe("transient");
    expect(classifyCodexUpstreamOutcome(102)).toBe("unknown");
  });

  test("three consecutive transient failures fail over future new threads", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);
    expect(resolveCodexAccountForThread("existing", config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("existing", config)).toBe("a");
    expect(resolveCodexAccountForThread("next", config)).toBe("b");
  });

  test("caller and model 4xx responses do not penalize account health", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);
    recordCodexUpstreamOutcome(config, "a", 400);
    recordCodexUpstreamOutcome(config, "a", 404);
    recordCodexUpstreamOutcome(config, "a", 422);
    expect(getCodexUpstreamHealth("a")).toBeNull();
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("401 credential outcome quarantines the account for future threads", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);
    expect(resolveCodexAccountForThread("credential-existing", config)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 401);

    expect(isAccountNeedsReauth("a")).toBe(true);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 401 });
    expect(resolveCodexAccountForThread("credential-existing", config)).toBe("b");
    expect(resolveCodexAccountForThread("credential-next", config)).toBe("b");
  });

  test("403 credential outcome quarantines the account under the conservative policy", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);

    recordCodexUpstreamOutcome(config, "a", 403);

    expect(isAccountNeedsReauth("a")).toBe(true);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 403 });
    expect(resolveCodexAccountForThread("credential-403-next", config)).toBe("b");
  });

  test("connect failures contribute to transient failover", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);
    recordCodexUpstreamOutcome(config, "a", "connect_error");
    recordCodexUpstreamOutcome(config, "a", "timeout");
    recordCodexUpstreamOutcome(config, "a", "connect_error");
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 3, lastFailureStatus: 0 });
    expect(resolveCodexAccountForThread("connect-next", config)).toBe("b");
  });

  test("429 with Retry-After records an account cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "120", now });

    expect(getCodexAccountCooldownUntil("a", now)).toBe(now + 120_000);
    expect(isCodexAccountInCooldown("a", now + 119_999)).toBe(true);
    expect(isCodexAccountInCooldown("a", now + 120_001)).toBe(false);
  });

  test("Retry-After HTTP date values are parsed as future cooldowns", () => {
    const now = Date.UTC(2026, 5, 24, 12, 0, 0);
    const retryAfter = new Date(now + 45_000).toUTCString();

    expect(parseRetryAfterMs(retryAfter, now)).toBe(45_000);
  });

  test("429 uses Codex reset headers as cooldown fallback", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 429, {
      now,
      resetAt: [
        String((now + 90_000) / 1000),
        String((now + 240_000) / 1000),
      ],
    });

    expect(getCodexAccountCooldownUntil("a", now)).toBe(now + 90_000);
  });

  test("429 on the active account clears affinity and switches new threads to an available pool account", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10, 5);
    updateAccountQuota("b", 20, 10);
    expect(resolveCodexAccountForThread("quota-existing", config)).toBe("a");

    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "60", now });

    expect(config.activeCodexAccountId).toBe("b");
    expect(resolveCodexAccountForThread("quota-existing", config)).toBe("b");
    expect(resolveCodexAccountForThread("quota-next", config)).toBe("b");
  });

  test("2xx responses clear transient failures without clearing an unexpired cooldown", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    recordCodexUpstreamOutcome(config, "a", 429, { retryAfter: "120", now });

    recordCodexUpstreamOutcome(config, "a", 200, { now: now + 1_000 });

    expect(getCodexAccountCooldownUntil("a", now + 1_000)).toBe(now + 120_000);
    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 0, cooldownUntil: now + 120_000 });
  });

  test("stale transient failure streaks expire before failover thresholding", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;

    recordCodexUpstreamOutcome(config, "a", 503, { now });
    recordCodexUpstreamOutcome(config, "a", 503, { now: now + CODEX_FAILURE_WINDOW_MS + 1 });

    expect(getCodexUpstreamHealth("a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 503 });
    expect(resolveCodexAccountForThread("stale-failure-next", config)).toBe("a");
  });

  test("2xx responses reset the failure streak", () => {
    const config = makeConfig();
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 200);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("failure failover can be disabled independently from quota switching", () => {
    const config = makeConfig({ upstreamFailoverThreshold: 0 });
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(resolveCodexAccountForThread("next", config)).toBe("a");
  });

  test("stale thread affinity is revalidated before reuse", () => {
    const config = makeConfig();
    expect(resolveCodexAccountForThread("stale-thread", config)).toBe("a");

    config.codexAccounts = config.codexAccounts?.filter(account => account.id !== "a");
    removeCodexAccountCredential("a");

    expect(resolveCodexAccountForThread("stale-thread", config)).toBe("b");
  });

  test("expired thread affinity is not silently remapped", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    expect(resolveCodexAccountForThread("expired-thread", config, now)).toBe("a");

    expect(resolveCodexAccountForThread(
      "expired-thread",
      config,
      now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1,
    )).toBeNull();
  });

  test("detailed resolver reports expired thread affinity", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    expect(resolveCodexAccountForThreadDetailed("expired-detailed", config, now))
      .toEqual({ status: "selected", accountId: "a" });

    expect(resolveCodexAccountForThreadDetailed(
      "expired-detailed",
      config,
      now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1,
    )).toEqual({ status: "expired", accountId: "a" });
  });

  test("thread affinity LRU cap evicts the oldest mapping", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    for (let i = 0; i < CODEX_THREAD_AFFINITY_MAX_ENTRIES + 1; i += 1) {
      expect(resolveCodexAccountForThread(`lru-${i}`, config, now + i)).toBe("a");
    }

    config.activeCodexAccountId = "b";

    expect(resolveCodexAccountForThread("lru-1", config, now + CODEX_THREAD_AFFINITY_MAX_ENTRIES + 1)).toBe("a");
    expect(resolveCodexAccountForThread("lru-0", config, now + CODEX_THREAD_AFFINITY_MAX_ENTRIES + 2)).toBe("b");
  });

  test("generation mismatch invalidates a mapped thread before reuse", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    expect(resolveCodexAccountForThread("generation-thread", config, now)).toBe("a");

    saveCodexAccountCredential("a", {
      accessToken: "replacement-a",
      refreshToken: "replacement-refresh-a",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-a",
    });
    config.activeCodexAccountId = "b";

    expect(resolveCodexAccountForThread("generation-thread", config, now + 1)).toBe("b");
  });

  test("account-specific cleanup clears affinity and upstream health", () => {
    const config = makeConfig();
    expect(resolveCodexAccountForThread("cleanup-thread", config)).toBe("a");
    recordCodexUpstreamOutcome(config, "a", 503);
    expect(getCodexUpstreamHealth("a")).not.toBeNull();

    clearThreadAccountMapForAccount("a");
    clearCodexUpstreamHealthForAccount("a");
    config.activeCodexAccountId = "b";

    expect(getCodexUpstreamHealth("a")).toBeNull();
    expect(resolveCodexAccountForThread("cleanup-thread", config)).toBe("b");
  });

  test("failover threshold API validates and mutates runtime config", async () => {
    const config = makeConfig();
    const badReq = new Request("http://localhost/api/codex-auth/failover", {
      method: "PUT",
      body: JSON.stringify({ threshold: 21 }),
    });
    expect((await handleCodexAuthAPI(badReq, new URL(badReq.url), config))!.status).toBe(400);
    const req = new Request("http://localhost/api/codex-auth/failover", {
      method: "PUT",
      body: JSON.stringify({ threshold: 4 }),
    });
    expect((await handleCodexAuthAPI(req, new URL(req.url), config))!.status).toBe(200);
    expect(config.upstreamFailoverThreshold).toBe(4);
  });

  test("WHAM tertiary window parses as optional 30d quota", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1 },
        secondary_window: { used_percent: 20, reset_at: 2 },
        tertiary_window: { used_percent: 30, reset_at: 3 },
      },
    });
    expect(quota).toMatchObject({
      fiveHourPercent: 10,
      weeklyPercent: 20,
      monthlyPercent: 30,
      fiveHourResetAt: 1,
      weeklyResetAt: 2,
      monthlyResetAt: 3,
    });
  });

  test("WHAM parser returns null when no valid quota window is present", () => {
    expect(parseUsageQuota({ rate_limit: {} })).toBeNull();
    expect(parseUsageQuota({
      rate_limit: {
        primary_window: { used_percent: Number.NaN },
        secondary_window: { used_percent: Number.POSITIVE_INFINITY },
      },
    })).toBeNull();
  });

  test("WHAM parser does not fabricate missing windows as zero", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        tertiary_window: { used_percent: 30, reset_at: 3 },
      },
    });
    expect(quota).toEqual({ monthlyPercent: 30, monthlyResetAt: 3 });
  });

  test("WHAM parser clamps finite out-of-range percentages and drops invalid windows", () => {
    const quota = parseUsageQuota({
      rate_limit: {
        primary_window: { used_percent: Number.NaN, reset_at: 1 },
        secondary_window: { used_percent: 150, reset_at: 2 },
        tertiary_window: { used_percent: -5, reset_at: -3 },
      },
    });
    expect(quota).toEqual({
      weeklyPercent: 100,
      monthlyPercent: 0,
      weeklyResetAt: 2,
    });
  });
});
