import { describe, expect, test } from "bun:test";
import { createCursorAdapter as createCursorAdapterProduction } from "../src/adapters/cursor";
import {
  CURSOR_ECHO_RETRY_CONTINUATION_TEXT,
  CursorEnvelopeEchoSniffer,
  CursorRoutingCommentarySniffer,
} from "../src/adapters/cursor/envelope-echo";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createCursorAdapter = (...args: Parameters<typeof createCursorAdapterProduction>) =>
  withTestTranslatorBudget(createCursorAdapterProduction(...args));

const provider: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://api2.cursor.sh" };

const ECHO_TEXT = "[Tool Result]\n[tool_result]\ncall_id: run_cmd_0_abc\nname: run_cmd\nis_error: false\noutput:\nR1=A17\n";

function toolResultBody(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: {
      messages: [
        { role: "user", content: "run the probe", timestamp: 1 },
        { role: "assistant", content: "Running it.", timestamp: 2 },
        { role: "toolResult", toolCallId: "call_1", toolName: "run_cmd", content: "R1=A17", isError: false, timestamp: 3 },
      ],
    },
    stream: false,
    options: {},
    _cursorConversationId: "cursor_echo_fixture",
    _cursorIdentityScope: "acct-echo",
  } as OcxParsedRequest;
}

/** First run echoes the envelope; the retry answers normally. Records each run request. */
function echoingThenHealthyTransportFactory() {
  const runRequests: CursorRunRequest[] = [];
  let attempt = 0;
  return {
    factory: (_input: unknown) => ({
      async *run(request: CursorRunRequest) {
        runRequests.push(request);
        attempt += 1;
        if (attempt === 1) {
          // Fragmented echo: marker split across deltas.
          yield { type: "text", text: "[Tool " } satisfies CursorServerMessage;
          yield { type: "text", text: "Result]\n[tool_result]\ncall_id: x" } satisfies CursorServerMessage;
          yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
          return;
        }
        yield { type: "text", text: "STATE A17" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    }),
    runRequests,
    attempts: () => attempt,
  };
}

describe("cursor external output quarantine + corrective retry (devlog 260826 gaps 10-11)", () => {
  test("sniffer: marker split across deltas is detected; divergent text flushes", () => {
    const echo = new CursorEnvelopeEchoSniffer();
    expect(echo.feed("[Tool ").kind).toBe("hold");
    expect(echo.feed("Result]").kind).toBe("echo");

    const normal = new CursorEnvelopeEchoSniffer();
    expect(normal.feed("[Tool ").kind).toBe("hold");
    expect(normal.feed("Belt] is a phrase").kind).toBe("flush");

    const plain = new CursorEnvelopeEchoSniffer();
    expect(plain.feed("STATE A17").kind).toBe("flush");

    const whitespace = new CursorEnvelopeEchoSniffer();
    expect(whitespace.feed("\n  [tool_result]").kind).toBe("echo");
  });

  test("routing-commentary sniffer catches fragmented invented fallback but not legitimate Shell prose", () => {
    const hallucination = new CursorRoutingCommentarySniffer();
    expect(hallucination.feed("Shell 경로는 또 같은 문구로 ").kind).toBe("hold");
    expect(hallucination.feed("차단됐으니, 통과가 확인된 ").kind).toBe("hold");
    expect(hallucination.feed("exec_command 경로로 읽겠습니다.").kind).toBe("hallucination");

    const multiToolClaim = new CursorRoutingCommentarySniffer();
    expect(multiToolClaim.feed("Read와 Grep이 모두 blocked 상태입니다.").kind).toBe("hallucination");

    const legitimate = new CursorRoutingCommentarySniffer();
    expect(legitimate.feed("Shell is unavailable on this operating system.").kind).toBe("hold");
    expect(legitimate.finish().kind).toBe("flush");
  });

  test("external tool-result echo retries once with the corrective action text and no leaked envelope", async () => {
    const { factory, runRequests, attempts } = echoingThenHealthyTransportFactory();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempts()).toBe(2);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("STATE A17");
    expect(text).not.toContain("[Tool Result]");
    expect(events.some(e => e.type === "done")).toBe(true);
    // Retry request carries the corrective continuation and a rotated conversation id.
    expect(runRequests).toHaveLength(2);
    expect(runRequests[1]?.echoRetryContinuationText).toBe(CURSOR_ECHO_RETRY_CONTINUATION_TEXT);
    expect(runRequests[1]?.conversationId).not.toBe(runRequests[0]?.conversationId);
  });

  test("double echo fails with an error instead of looping", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(2);
    const errors = events.filter(e => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).not.toContain("[Tool Result]");
  });

  test("normal external continuation is unaffected (single attempt, text intact)", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: "[note] leading bracket but " } satisfies CursorServerMessage;
        yield { type: "text", text: "not an envelope" } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(toolResultBody("cursor/kimi-k3"), { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("[note] leading bracket but not an envelope");
  });

  test("plain user turns (no trailing toolResult) never arm the sniffer", async () => {
    let attempt = 0;
    const factory = () => ({
      async *run() {
        attempt += 1;
        yield { type: "text", text: ECHO_TEXT } satisfies CursorServerMessage;
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    const body = {
      modelId: "cursor/kimi-k3",
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_echo_plain",
      _cursorIdentityScope: "acct-echo",
    } as OcxParsedRequest;
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempt).toBe(1);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toContain("[Tool Result]");
  });

  test("user-action round with a replayed toolResult in history arms the sniffer and retries", async () => {
    const { factory, runRequests, attempts } = echoingThenHealthyTransportFactory();
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    const body = {
      modelId: "cursor/kimi-k3",
      context: {
        messages: [
          { role: "user", content: "run the probe", timestamp: 1 },
          { role: "assistant", content: "Running it.", timestamp: 2 },
          { role: "toolResult", toolCallId: "call_1", toolName: "run_cmd", content: "R1=A17", isError: false, timestamp: 3 },
          { role: "assistant", content: "STATE A17", timestamp: 4 },
          { role: "user", content: "Round 2. continue", timestamp: 5 },
        ],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_echo_user_round",
      _cursorIdentityScope: "acct-echo",
    } as OcxParsedRequest;
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    expect(attempts()).toBe(2);
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(text).toBe("STATE A17");
    expect(runRequests[1]?.echoRetryContinuationText).toBeDefined();
  });

  test("code-mode routing commentary that invents a blocked native Shell is quarantined and retried", async () => {
    let attempt = 0;
    const runRequests: CursorRunRequest[] = [];
    const factory = () => ({
      async *run(request: CursorRunRequest) {
        runRequests.push(request);
        attempt += 1;
        if (attempt === 1) {
          yield {
            type: "text",
            text: "`Shell` 경로는 또 같은 문구로 차단됐으니, 통과가 확인된 `exec_command` 경로로 읽겠습니다.",
          } satisfies CursorServerMessage;
        } else {
          yield { type: "text", text: "READ_OK" } satisfies CursorServerMessage;
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } } satisfies CursorServerMessage;
      },
      writeClient() {},
    });
    const body = {
      modelId: "cursor/kimi-k3-1m",
      context: {
        messages: [{ role: "user", content: "Read the file and report its first line.", timestamp: 1 }],
        tools: [{
          name: "exec",
          description: "Run JavaScript code to orchestrate nested tool calls.",
          parameters: {},
          freeform: true,
        }],
      },
      stream: false,
      options: {},
      _cursorConversationId: "cursor_routing_commentary",
      _cursorIdentityScope: "acct-routing-commentary",
    } as OcxParsedRequest;
    const adapter = createCursorAdapter({ ...provider, apiKey: "cursor-token" }, { createTransport: factory as never });
    const events: AdapterEvent[] = [];
    await adapter.runTurn?.(body, { headers: new Headers() }, event => events.push(event));
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("");
    expect(attempt).toBe(2);
    expect(text).toBe("READ_OK");
    expect(text).not.toContain("Shell");
    expect(runRequests[1]?.echoRetryContinuationText).toBeDefined();
  });
});
