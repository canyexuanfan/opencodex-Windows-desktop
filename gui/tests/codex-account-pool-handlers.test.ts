import { afterEach, beforeEach, expect, test } from "bun:test";
import { redeemResetCredit } from "../src/components/codex-account-pool-handlers";
import type { CodexAccountEntry } from "../src/components/codex-account-pool-types";
import type { TFn } from "../src/i18n";

const t: TFn = ((key: string, vars?: Record<string, string | number>) => {
  if (!vars) return key;
  return `${key}:${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}`;
}) as TFn;

let originalFetch: typeof globalThis.fetch;
let consumeBody: { code: string; remaining?: number } | null = null;
let loadCalls = 0;

const popup: CodexAccountEntry = {
  id: "acct-1",
  email: "a@example.test",
  isMain: false,
  hasCredential: true,
  quota: { resetCredits: 3, updatedAt: 1 },
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  consumeBody = null;
  loadCalls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json(consumeBody ?? { code: "error" }),
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test("already_redeemed never invents a decrement when the server omits remaining", async () => {
  consumeBody = { code: "already_redeemed" };
  const result = await redeemResetCredit("", "acct-1", t, popup, async () => {
    loadCalls += 1;
    return true;
  });

  expect(loadCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.close).toBe(true);
  // Keep the known count; do not toast "2 remaining" from a local guess.
  expect(result.toast).toBe("codexAuth.resetSuccess:remaining=3");
  expect(result.toast).not.toContain("remaining=2");
});

test("already_redeemed prefers the authoritative server remaining count", async () => {
  consumeBody = { code: "already_redeemed", remaining: 3 };
  const result = await redeemResetCredit("", "acct-1", t, popup, async () => true);

  expect(result.ok).toBe(true);
  expect(result.toast).toBe("codexAuth.resetSuccess:remaining=3");
});

test("already_redeemed without known credits uses the dedicated toast, not a guessed count", async () => {
  consumeBody = { code: "already_redeemed" };
  const noCredits: CodexAccountEntry = { ...popup, quota: { updatedAt: 1 } };
  const result = await redeemResetCredit("", "acct-1", t, noCredits, async () => true);

  expect(result.ok).toBe(true);
  expect(result.toast).toBe("codexAuth.resetAlreadyRedeemed");
});

test("failure paths return ok:false so callers can set toastError from result.ok", async () => {
  consumeBody = { code: "no_credit" };
  const result = await redeemResetCredit("", "acct-1", t, popup, async () => true);

  expect(result.ok).toBe(false);
  expect(result.toast).toBe("codexAuth.resetNoCredit");
});
