import { describe, expect, test } from "bun:test";
import {
  filterRequestLogs,
  nextRequestLogId,
  requestLogErrorCode,
  type RequestLogEntry,
} from "../src/server";

function log(overrides: Partial<RequestLogEntry>): RequestLogEntry {
  return {
    requestId: "ocx-test",
    timestamp: 1,
    model: "gpt-test",
    provider: "openai",
    status: 200,
    durationMs: 10,
    ...overrides,
  };
}

describe("request log metadata", () => {
  test("generates compact request ids", () => {
    expect(nextRequestLogId(1_700_000_000_000)).toMatch(/^ocx-[a-z0-9]+-[a-z0-9]+$/);
    expect(nextRequestLogId(1_700_000_000_000)).not.toBe(nextRequestLogId(1_700_000_000_000));
  });

  test("classifies status codes without reading response bodies", () => {
    expect(requestLogErrorCode(200)).toBeUndefined();
    expect(requestLogErrorCode(400)).toBe("invalid_request_error");
    expect(requestLogErrorCode(401)).toBe("invalid_api_key");
    expect(requestLogErrorCode(429)).toBe("rate_limit_exceeded");
    expect(requestLogErrorCode(499)).toBe("client_closed_request");
    expect(requestLogErrorCode(503)).toBe("server_is_overloaded");
    expect(requestLogErrorCode(502)).toBe("upstream_server_error");
    expect(requestLogErrorCode(404)).toBe("http_404");
    expect(requestLogErrorCode(418)).toBe("http_418");
  });

  test("filters logs by provider, status, and tail", () => {
    const logs = [
      log({ requestId: "a", provider: "openai", status: 200 }),
      log({ requestId: "b", provider: "umans", status: 429 }),
      log({ requestId: "c", provider: "umans", status: 502 }),
      log({ requestId: "d", provider: "opencode-go", status: 500 }),
    ];

    expect(filterRequestLogs(logs, new URLSearchParams("provider=umans")).map(entry => entry.requestId)).toEqual(["b", "c"]);
    expect(filterRequestLogs(logs, new URLSearchParams("status=5xx")).map(entry => entry.requestId)).toEqual(["c", "d"]);
    expect(filterRequestLogs(logs, new URLSearchParams("status=429")).map(entry => entry.requestId)).toEqual(["b"]);
    expect(filterRequestLogs(logs, new URLSearchParams("tail=2")).map(entry => entry.requestId)).toEqual(["c", "d"]);

    const combined = filterRequestLogs(logs, new URLSearchParams("provider=umans&status=5xx&tail=1"));
    expect(combined.map(entry => entry.requestId)).toEqual(["c"]);
  });
});
