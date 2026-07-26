import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  conversationIdFromClaudeCacheKey,
  conversationIdFromResponsesRequest,
  normalizeLogConversationId,
  summarizeConversationLogs,
} from "../src/server/request-log-conversation";
import {
  filterRequestLogs,
  requestLogEntryFromPersistedUsage,
  type RequestLogEntry,
} from "../src/server/request-log";
import type { PersistedUsageEntry } from "../src/usage/log";

function log(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: "ocx-test",
    timestamp: 1,
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 10,
    usageStatus: "reported",
    ...overrides,
  };
}

describe("normalizeLogConversationId", () => {
  test("trims and rejects empty / control characters", () => {
    expect(normalizeLogConversationId("  abc  ")).toBe("abc");
    expect(normalizeLogConversationId("")).toBeUndefined();
    expect(normalizeLogConversationId("   ")).toBeUndefined();
    expect(normalizeLogConversationId("bad\nid")).toBeUndefined();
    expect(normalizeLogConversationId(null)).toBeUndefined();
  });

  test("hashes ids longer than 128 chars to a stable short key", () => {
    const long = "x".repeat(200);
    const expected = createHash("sha256").update(long).digest("hex").slice(0, 32);
    expect(normalizeLogConversationId(long)).toBe(expected);
    expect(normalizeLogConversationId(long)).toBe(normalizeLogConversationId(long));
  });
});

describe("conversationIdFromResponsesRequest", () => {
  test("prefers parent thread header over session / thread / cursor", () => {
    expect(conversationIdFromResponsesRequest({
      clientThreadId: "parent-thread",
      sessionIdHeader: "session",
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
    })).toBe("parent-thread");
    expect(conversationIdFromResponsesRequest({
      sessionIdHeader: "session",
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
    })).toBe("session");
    expect(conversationIdFromResponsesRequest({
      threadIdHeader: "thread",
      cursorConversationId: "cursor",
    })).toBe("thread");
    expect(conversationIdFromResponsesRequest({
      cursorConversationId: "cursor",
    })).toBe("cursor");
  });
});

describe("conversationIdFromClaudeCacheKey", () => {
  test("only accepts metadata-derived cache keys", () => {
    expect(conversationIdFromClaudeCacheKey("metadata", "session-key")).toBe("session-key");
    expect(conversationIdFromClaudeCacheKey("system", "system-hash")).toBeUndefined();
    expect(conversationIdFromClaudeCacheKey(null, "session-key")).toBeUndefined();
  });
});

describe("summarizeConversationLogs", () => {
  test("sums tokens and priced cost while counting exclusions", () => {
    const totals = summarizeConversationLogs([
      {
        totalTokens: 100,
        usageStatus: "reported",
        displayMetrics: { cost: { kind: "value", estimate: { cost: { total: 0.01 } } } },
      },
      {
        usage: { inputTokens: 10, outputTokens: 5 },
        usageStatus: "reported",
        displayMetrics: { cost: { kind: "unavailable", reason: "price_unmatched" } },
      },
      {
        totalTokens: 50,
        usageStatus: "unsupported",
      },
    ]);
    expect(totals).toEqual({
      requests: 3,
      totalTokens: 165,
      estimatedCostUsd: 0.01,
      pricedRequests: 1,
      unpricedRequests: 1,
      unmeteredRequests: 1,
    });
  });
});

describe("request log conversation persistence / filter", () => {
  test("filterRequestLogs matches conversationId and conversation aliases", () => {
    const logs = [
      log({ requestId: "a", conversationId: "conv-1" }),
      log({ requestId: "b", conversationId: "conv-2" }),
      log({ requestId: "c" }),
    ];
    expect(filterRequestLogs(logs, new URLSearchParams("conversationId=conv-1")).map(e => e.requestId))
      .toEqual(["a"]);
    expect(filterRequestLogs(logs, new URLSearchParams("conversation=conv-2")).map(e => e.requestId))
      .toEqual(["b"]);
  });

  test("hydrated usage rows keep conversationId", () => {
    const persisted: PersistedUsageEntry = {
      requestId: "round",
      timestamp: 1,
      provider: "openai",
      model: "gpt-test",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      conversationId: "thread-xyz",
    };
    expect(requestLogEntryFromPersistedUsage(persisted).conversationId).toBe("thread-xyz");
  });
});
