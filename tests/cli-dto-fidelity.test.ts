import { describe, expect, test } from "bun:test";
import { formatUsageReport } from "../src/cli/usage-report";

/** formatUsageReport returns lines; assertions here are about rendered text. */
const joinReport = (input: Parameters<typeof formatUsageReport>[0]): string => formatUsageReport(input).join("\n");
import { formatAccountTable, type AccountRowForTest } from "../src/cli/account";

/**
 * #2700, #2703: the CLI discarded fields the API already returned.
 *
 * Each case here is a field that existed on the wire, was declared in a type, and never
 * reached the operator -- the failure mode where the code typechecks, the renderer reads
 * correctly, and only the output is wrong.
 */
describe("#2700 usage report renders per-account totals", () => {
  const base = {
    range: "7d",
    summary: { requests: 10, totalTokens: 1000, estimatedCostUsd: 1.5 },
  };

  test("renders an ACCOUNT table with requests, tokens, and cost", () => {
    const out = joinReport({
      ...base,
      accounts: [
        { accountLogLabel: "work", requests: 7, totalTokens: 700, estimatedCostUsd: 1.25 },
      ],
    });
    expect(out).toContain("ACCOUNT");
    expect(out).toContain("work");
    expect(out).toContain("700");
  });

  test("marks an ambiguous row instead of presenting it as one account", () => {
    // A legacy-ambiguous row aggregates several accounts. An operator who reads it as a
    // single identity draws the wrong conclusion about who spent what.
    const out = joinReport({
      ...base,
      accounts: [{ accountLogLabel: "legacy-ambiguous", ambiguous: true, requests: 3, totalTokens: 300 }],
    });
    expect(out).toContain("legacy-ambiguous (ambiguous)");
  });

  test("drops rows with no requests rather than printing empty ones", () => {
    const out = joinReport({
      ...base,
      accounts: [
        { accountLogLabel: "busy", requests: 4, totalTokens: 400 },
        { accountLogLabel: "idle", requests: 0, totalTokens: 0 },
      ],
    });
    expect(out).toContain("busy");
    expect(out).not.toContain("idle");
  });

  test("states that account rows are WITHHELD under a provider filter", () => {
    // The server sends `accounts: []` under any filter because the rows cannot be honestly
    // re-partitioned. Printing nothing would look like "no accounts used this provider",
    // which is a different and wrong answer -- the same silently-wrong-output class of defect
    // this phase exists to remove.
    const out = joinReport({
      ...base,
      accounts: [],
      filter: { provider: "xai", model: null, matched: true, comboOverlap: false },
    });
    expect(out).toContain("not reported under a provider or model filter");
  });

  test("states the same under a model filter", () => {
    const out = joinReport({
      ...base,
      accounts: [],
      filter: { provider: null, model: "grok-4", matched: true, comboOverlap: false },
    });
    expect(out).toContain("not reported under a provider or model filter");
  });

  test("the withheld note wins even if rows are somehow present under a filter", () => {
    // Defensive on purpose: if a future server sends filtered account rows, the honest
    // statement is better than a table whose partitioning nobody has justified.
    const out = joinReport({
      ...base,
      accounts: [{ accountLogLabel: "work", requests: 5, totalTokens: 500 }],
      filter: { provider: "xai", model: null, matched: true, comboOverlap: false },
    });
    expect(out).toContain("not reported under a provider or model filter");
  });

  test("prints no ACCOUNT section at all when unfiltered with no rows", () => {
    const out = joinReport({ ...base, accounts: [] });
    expect(out).not.toContain("ACCOUNT");
  });
});

describe("#2703 paused state and the 5h window reach the operator", () => {
  const row = (over: Partial<AccountRowForTest> = {}): AccountRowForTest => ({
    provider: "openai",
    type: "codex",
    id: "acct_1",
    active: false,
    ...over,
  }) as AccountRowForTest;

  test("a paused account is named as paused", () => {
    expect(formatAccountTable([row({ paused: true })])).toContain("paused");
  });

  test("paused and selected are BOTH shown, not one or the other", () => {
    // A paused-but-selected account is the state most worth naming: requests route to it
    // while the pool believes it is held out of rotation. Showing only one hides that.
    const out = formatAccountTable([row({ paused: true, active: true })]);
    expect(out).toContain("paused");
    expect(out).toContain("selected");
  });

  test("an unpaused account says nothing about pausing", () => {
    expect(formatAccountTable([row({ paused: false })])).not.toContain("paused");
  });

  test("a 5h-only quota renders instead of collapsing to a dash", () => {
    const out = formatAccountTable([row({ quota: { fiveHourPercent: 42 } })], true);
    expect(out).toContain("5h 42%");
  });
});

describe("#2703 the projection does not strip the 5h window", () => {
  /**
   * Renderer tests alone were VACUOUS for this bug.
   *
   * `formatAccountTable` reads a row directly, so it passed with the defect still present --
   * the field was dropped one layer earlier, in `projectQuota`'s whitelist inside
   * `fetchCodexRows`. Verified by reverting the fix and watching the renderer test stay green.
   * So this drives the real path: a server payload in, a projected row out.
   */
  async function rowsFromServer(quota: Record<string, number>): Promise<{ quota?: unknown }[]> {
    const { fetchCodexRows } = await import("../src/cli/account-api");
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/api/codex-auth/active")) {
        return new Response(JSON.stringify({ activeCodexAccountId: "acct_1" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        accounts: [{ id: "acct_1", email: "a@example.com", plan: "pro", quota, paused: true }],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCodexRows({ baseUrl: "http://127.0.0.1:10100", fetchImpl }, "http://127.0.0.1:10100", true);
    return result.rows as { quota?: unknown }[];
  }

  test("fiveHourPercent and fiveHourResetAt survive the projection", async () => {
    const rows = await rowsFromServer({ fiveHourPercent: 42, fiveHourResetAt: 1_800_000_000 });
    const quota = rows[0]?.quota as Record<string, number> | undefined;
    expect(quota?.fiveHourPercent).toBe(42);
    expect(quota?.fiveHourResetAt).toBe(1_800_000_000);
  });

  test("paused survives the projection", async () => {
    const rows = await rowsFromServer({ fiveHourPercent: 10 }) as { paused?: boolean }[];
    expect(rows[0]?.paused).toBe(true);
  });

  test("the existing windows still survive", async () => {
    // Guards against a whitelist edit that adds the 5h keys and drops another.
    const rows = await rowsFromServer({ weeklyPercent: 7, monthlyPercent: 3, shortPercent: 1 });
    const quota = rows[0]?.quota as Record<string, number> | undefined;
    expect(quota?.weeklyPercent).toBe(7);
    expect(quota?.monthlyPercent).toBe(3);
    expect(quota?.shortPercent).toBe(1);
  });
});
