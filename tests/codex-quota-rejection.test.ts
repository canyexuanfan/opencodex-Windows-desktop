import { describe, expect, test } from "bun:test";
import { classifyCodexPreStreamRejection } from "../src/codex/quota-rejection";

function jsonRejection(status: number, error: Record<string, unknown>): Response {
  return Response.json({ error }, { status });
}

function jsonPayload(status: number, payload: Record<string, unknown>): Response {
  return Response.json(payload, { status });
}

describe("Codex pre-stream quota rejection classification", () => {
  test.each([
    [429, "nested code", { error: { code: "usage_limit_exceeded" } }, "usage_limit_exceeded"],
    [429, "nested type", { error: { type: "insufficient_quota" } }, "insufficient_quota"],
    [402, "nested code", { error: { code: "insufficient_quota" } }, "insufficient_quota"],
    [429, "root code", { code: "usage_limit_exceeded" }, "usage_limit_exceeded"],
    [402, "root type", { type: "insufficient_quota" }, "insufficient_quota"],
    [429, "matching code and type", {
      error: { code: "usage_limit_exceeded", type: "usage_limit_exceeded" },
    }, "usage_limit_exceeded"],
  ] as const)("accepts exact %s reset-eligible exhaustion on HTTP %i", async (
    status,
    _schema,
    payload,
    code,
  ) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(status, payload));
    expect(result).toEqual({
      kind: "reset-eligible-exhaustion",
      status,
      alternateRetryEligible: true,
      resetCreditEligible: true,
      semanticCode: code,
    });
  });

  test.each([
    ["leading and trailing whitespace", { error: { code: " usage_limit_exceeded " } }],
    ["uppercase", { error: { code: "USAGE_LIMIT_EXCEEDED" } }],
    ["mixed case", { type: "Insufficient_Quota" }],
    ["trailing whitespace at the root", { code: "insufficient_quota " }],
  ] as const)("rejects the %s near-miss", async (_case, payload) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(429, payload));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
  });

  test.each([
    ["primitive error with a root code", {
      error: "opaque",
      code: "usage_limit_exceeded",
    }],
    ["matching root and nested codes", {
      code: "usage_limit_exceeded",
      error: { code: "usage_limit_exceeded" },
    }],
    ["unknown root and eligible nested codes", {
      code: "unknown",
      error: { code: "usage_limit_exceeded" },
    }],
    ["eligible root code with an empty nested error", {
      code: "usage_limit_exceeded",
      error: {},
    }],
  ] as const)("fails closed for ambiguous schemas: %s", async (_case, payload) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(429, payload));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
  });

  test.each([
    ["nested unknown code and eligible type", {
      error: { code: "unknown", type: "insufficient_quota" },
    }],
    ["root eligible code and unrelated type", {
      code: "usage_limit_exceeded",
      type: "rate_limit_error",
    }],
    ["two different eligible values", {
      error: { code: "usage_limit_exceeded", type: "insufficient_quota" },
    }],
    ["eligible code and non-string type", {
      error: { code: "usage_limit_exceeded", type: null },
    }],
  ] as const)("fails closed for code/type disagreement: %s", async (_case, payload) => {
    const result = await classifyCodexPreStreamRejection(jsonPayload(429, payload));
    expect(result).toMatchObject({
      kind: "generic-rate-limit",
      alternateRetryEligible: true,
      resetCreditEligible: false,
    });
    expect(result).not.toHaveProperty("semanticCode");
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
