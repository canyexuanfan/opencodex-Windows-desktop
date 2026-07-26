import { describe, expect, test } from "bun:test";
import { formatErrorResponse } from "../src/bridge";
import {
  DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC,
  resolveClientRetryAfter,
} from "../src/lib/retry-after";
import { formatPassthroughUpstreamError } from "../src/server/responses/passthrough-error";

describe("resolveClientRetryAfter (#507)", () => {
  test("prefers a validated upstream Retry-After header", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Too Many Requests",
      upstreamRetryAfter: "15",
    })).toBe("15");
  });

  test("parses delay hints embedded in the error message", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Throttled. Please try again in 7s.",
    })).toBe("7");
  });

  test("defaults retryable rate-limit 429s when upstream omitted Retry-After", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Too many requests — please slow down",
    })).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
  });

  test("does not invent Retry-After for quota-exhausted 429s", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "Kiro quota exhausted: monthly quota exceeded",
    })).toBeUndefined();
  });

  test("does not invent Retry-After for non-429 statuses", () => {
    expect(resolveClientRetryAfter({
      status: 503,
      message: "Service Unavailable",
    })).toBeUndefined();
  });

  test("drops invalid upstream Retry-After and falls through to the 429 default", () => {
    expect(resolveClientRetryAfter({
      status: 429,
      message: "rate limited",
      upstreamRetryAfter: "not-a-delay",
    })).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
  });
});

describe("formatErrorResponse Retry-After (#507)", () => {
  test("attaches Retry-After when provided", () => {
    const response = formatErrorResponse(429, "rate_limit_error", "Too Many Requests", {
      retryAfter: "2",
    });
    expect(response.headers.get("Retry-After")).toBe("2");
  });
});

describe("formatPassthroughUpstreamError Retry-After (#507)", () => {
  test("empty-body retryable 429 gets a default Retry-After", async () => {
    const response = formatPassthroughUpstreamError(429, "");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
    const json = await response.json() as { error?: { message?: string } };
    expect(json.error?.message).toContain("429");
  });

  test("empty-body quota 429 does not invent Retry-After", () => {
    // Message used for classification comes from the body text.
    const response = formatPassthroughUpstreamError(
      429,
      JSON.stringify({ error: { message: "exceeded your current quota" } }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  test("non-empty retryable 429 without Retry-After gets the default", () => {
    const body = JSON.stringify({ error: { message: "Too many requests" } });
    const response = formatPassthroughUpstreamError(429, body);
    expect(response.headers.get("Retry-After")).toBe(DEFAULT_RETRYABLE_429_RETRY_AFTER_SEC);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("preserves an explicit upstream Retry-After on non-empty 429", () => {
    const body = JSON.stringify({ error: { message: "Too many requests" } });
    const headers = new Headers({ "retry-after": "30", "content-type": "application/json" });
    const response = formatPassthroughUpstreamError(429, body, { headers });
    expect(response.headers.get("Retry-After")).toBe("30");
  });
});
