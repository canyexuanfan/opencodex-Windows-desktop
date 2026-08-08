import { afterEach, describe, expect, test } from "bun:test";

import { clearAccountQuota, setAccountQuotaFromParsed } from "../src/codex/quota";
import { codexPoolQuotaEvidence } from "../src/routing/quota";

afterEach(() => clearAccountQuota());

describe("Codex pool quota evidence for routing policies", () => {
  test("uses the best known usable headroom instead of only one active account", () => {
    setAccountQuotaFromParsed("low", { weeklyPercent: 95 });
    setAccountQuotaFromParsed("healthy", { weeklyPercent: 20 });

    expect(codexPoolQuotaEvidence([
      { accountId: "low", plan: "plus" },
      { accountId: "healthy", plan: "plus" },
    ])).toMatchObject({
      known: true,
      exhausted: false,
      headroom: 0.8,
      source: "codex-pool",
    });
  });

  test("reports exhausted only when every pool account is known exhausted", () => {
    setAccountQuotaFromParsed("a", { weeklyPercent: 100, weeklyResetAt: Date.now() + 60_000 });
    setAccountQuotaFromParsed("b", { weeklyPercent: 100, weeklyResetAt: Date.now() + 120_000 });

    const evidence = codexPoolQuotaEvidence([
      { accountId: "a", plan: "plus" },
      { accountId: "b", plan: "plus" },
    ]);

    expect(evidence.known).toBe(true);
    expect(evidence.exhausted).toBe(true);
    expect(evidence.headroom).toBe(0);
    expect(evidence.resetAtMs).toBeDefined();
  });

  test("does not call a partially unknown pool exhausted", () => {
    setAccountQuotaFromParsed("known-exhausted", { weeklyPercent: 100 });

    expect(codexPoolQuotaEvidence([
      { accountId: "known-exhausted", plan: "plus" },
      { accountId: "unknown", plan: "plus" },
    ])).toEqual({ known: false });
  });
});
