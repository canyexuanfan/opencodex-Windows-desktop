import { describe, expect, test } from "bun:test";
import {
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
} from "../src/providers/key-failover";
import type { OcxProviderConfig } from "../src/types";

describe("rateLimitRetryPolicyFor", () => {
  test("null when absent or explicitly disabled", () => {
    expect(rateLimitRetryPolicyFor({} as OcxProviderConfig)).toBeNull();
    expect(rateLimitRetryPolicyFor({ retryOn429: { enabled: false } } as OcxProviderConfig)).toBeNull();
  });

  test("applies defaults when the object is present", () => {
    expect(rateLimitRetryPolicyFor({ retryOn429: {} } as OcxProviderConfig)).toEqual({
      enabled: true,
      attempts: 3,
      intervalMs: 5_000,
      maxIntervalMs: 60_000,
      respectRetryAfter: true,
    });
  });

  test("honors explicit values", () => {
    expect(rateLimitRetryPolicyFor({
      retryOn429: { attempts: 10, intervalMs: 1_000, maxIntervalMs: 5_000, respectRetryAfter: false },
    } as OcxProviderConfig)).toEqual({
      enabled: true,
      attempts: 10,
      intervalMs: 1_000,
      maxIntervalMs: 5_000,
      respectRetryAfter: false,
    });
  });
});

describe("rateLimitRetryDelayMs", () => {
  const policy = rateLimitRetryPolicyFor({ retryOn429: {} } as OcxProviderConfig)!;

  test("fixed interval when no header is present", () => {
    expect(rateLimitRetryDelayMs(policy, null, 1_000_000)).toBe(5_000);
    expect(rateLimitRetryDelayMs(policy, undefined, 1_000_000)).toBe(5_000);
  });

  test("honors Retry-After seconds and caps it at maxIntervalMs", () => {
    expect(rateLimitRetryDelayMs(policy, "2", 1_000_000)).toBe(2_000);
    expect(rateLimitRetryDelayMs(policy, "3600", 1_000_000)).toBe(60_000);
  });

  test("malformed Retry-After falls back to the fixed interval", () => {
    expect(rateLimitRetryDelayMs(policy, "soon", 1_000_000)).toBe(5_000);
  });

  test("respectRetryAfter=false ignores the header", () => {
    const p = rateLimitRetryPolicyFor({
      retryOn429: { respectRetryAfter: false, intervalMs: 111 },
    } as OcxProviderConfig)!;
    expect(rateLimitRetryDelayMs(p, "2", 1_000_000)).toBe(111);
  });
});
