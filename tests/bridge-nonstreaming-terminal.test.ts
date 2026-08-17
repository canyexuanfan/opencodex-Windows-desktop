import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function sseText(events: AdapterEvent[]): Promise<string> {
  async function* source(): AsyncGenerator<AdapterEvent> {
    for (const e of events) yield e;
  }
  return await new Response(bridgeToResponsesSSE(source(), "routed/model")).text();
}

function terminalEventNames(text: string): string[] {
  return text.split("\n\n")
    .map(f => f.trim())
    .map(f => f.split("\n").find(l => l.startsWith("event: "))?.slice(7) ?? "")
    .filter(n => n === "response.completed" || n === "response.incomplete" || n === "response.failed");
}

describe("buffered turns without an adapter terminal", () => {
  test("text with no done/error is not reported as completed", () => {
    const json = buildResponseJSON([{ type: "text", text: "partial answer" }], "routed/model");

    // The adapter stopped emitting mid-turn. Calling that a success is the shape that let a
    // truncated Cursor turn look finished.
    expect(json.status).toBe("incomplete");
    expect((json as { incomplete_details?: { reason?: string } }).incomplete_details?.reason).toBe("adapter_eof");
  });

  test("a tool call left open is never returned as a completed function call", () => {
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"tru' },
    ], "routed/model");

    // The worst shape: a caller trusting `status` would try to execute half-written JSON.
    expect(json.status).toBe("incomplete");
    const call = json.output.find(o => (o as { type: string }).type === "function_call") as
      { status?: string; arguments?: string } | undefined;
    expect(call).toBeDefined();
    expect(call?.status).toBe("incomplete");
    expect(call?.arguments).toBe('{"code":"tru');
  });

  test("streaming and buffered agree on the terminal for the same events", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"tru' },
    ];

    // Parity is the property that keeps these two paths from drifting apart again.
    expect(terminalEventNames(await sseText(events))).toEqual(["response.incomplete"]);
    expect(buildResponseJSON(events, "routed/model").status).toBe("incomplete");
  });

  test("an explicit done still completes", () => {
    const json = buildResponseJSON([
      { type: "text", text: "answer" },
      { type: "done" },
    ], "routed/model");

    expect(json.status).toBe("completed");
    expect((json as { incomplete_details?: unknown }).incomplete_details).toBeUndefined();
  });

  test("explicit error and explicit incomplete keep their own outcomes", () => {
    const failed = buildResponseJSON([
      { type: "text", text: "partial" },
      { type: "error", message: "upstream failed" },
    ], "routed/model");
    expect(failed.status).toBe("failed");

    const incomplete = buildResponseJSON([
      { type: "text", text: "partial" },
      { type: "incomplete", reason: "max_output_tokens" },
    ], "routed/model");
    expect(incomplete.status).toBe("incomplete");
    // The adapter's own reason must survive, not be overwritten by adapter_eof.
    expect((incomplete as { incomplete_details?: { reason?: string } }).incomplete_details?.reason)
      .toBe("max_output_tokens");
  });

  test("a completed tool call with a done event is unaffected", () => {
    const json = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "js" },
      { type: "tool_call_delta", arguments: '{"code":"ok"}' },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "routed/model");

    expect(json.status).toBe("completed");
    const call = json.output.find(o => (o as { type: string }).type === "function_call") as
      { status?: string } | undefined;
    expect(call?.status).toBe("completed");
  });
});

