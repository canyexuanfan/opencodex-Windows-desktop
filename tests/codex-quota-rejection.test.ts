import { describe, expect, test } from "bun:test";
import { classifyCodexPreStreamRejection } from "../src/codex/quota-rejection";

function jsonRejection(status: number, error: Record<string, unknown>): Response {
  return Response.json({ error }, { status });
}

describe("Codex pre-stream quota rejection classification", () => {
  test.each([
    [429, "code", "usage_limit_exceeded"],
    [429, "type", "insufficient_quota"],
    [402, "code", "insufficient_quota"],
  ] as const)("accepts structured reset-eligible exhaustion on HTTP %i", async (status, field, code) => {
    const result = await classifyCodexPreStreamRejection(jsonRejection(status, { [field]: code }));
    expect(result).toEqual({
      kind: "reset-eligible-exhaustion",
      status,
      alternateRetryEligible: true,
      resetCreditEligible: true,
      semanticCode: code,
    });
  });

  test("keeps a generic 429 with Retry-After out of reset-credit eligibility", async () => {
    const response = jsonRejection(429, {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "try again later",
    });
    response.headers.set("retry-after", "60");
    await expect(classifyCodexPreStreamRejection(response)).resolves.toEqual({
      kind: "generic-rate-limit",
      status: 429,
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });

  test("does not trust reset-eligible words found only in a message", async () => {
    const result = await classifyCodexPreStreamRejection(jsonRejection(429, {
      type: "rate_limit_error",
      message: "usage_limit_exceeded: insufficient_quota",
    }));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });

  test("fails closed for malformed JSON while preserving broad 429 failover", async () => {
    const response = new Response('{"error":', {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    const result = await classifyCodexPreStreamRejection(response);
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(await response.text()).toBe('{"error":');
  });

  test.each([
    [503, "transient-server-error"],
    [401, "authentication-error"],
    [403, "permission-error"],
    [400, "other"],
  ] as const)("separates non-eligible HTTP %i as %s", async (status, kind) => {
    const result = await classifyCodexPreStreamRejection(jsonRejection(status, {
      code: "usage_limit_exceeded",
    }));
    expect(result).toMatchObject({
      kind,
      alternateRetryEligible: false,
      resetCreditEligible: false,
    });
  });

  test("classifies an unverified 402 without authorizing a reset credit", async () => {
    await expect(classifyCodexPreStreamRejection(jsonRejection(402, {
      code: "billing_error",
    }))).resolves.toEqual({
      kind: "unverified-billing-or-quota",
      status: 402,
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });

  test("an aborted body read fails closed and leaves generic failover eligible", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await classifyCodexPreStreamRejection(
      jsonRejection(429, { code: "usage_limit_exceeded" }),
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
  });
});
