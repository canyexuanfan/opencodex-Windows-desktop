import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { createKiroAdapter } from "../src/adapters/kiro";
import { estimateTokens } from "../src/lib/token-estimate";
import { configuredReasoningEfforts, mapReasoningEffort } from "../src/reasoning-effort";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const enc = new TextEncoder();
const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
let tmp: string;

beforeEach(() => {
  // isolate: empty HOME so no kiro-cli SQLite is read; deterministic region.
  tmp = mkdtempSync(join(tmpdir(), "kiro-adapter-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_PROFILE_ARN;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;

function parsedWith(messages: unknown[], tools?: unknown[]): OcxParsedRequest {
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages, tools } } as unknown as OcxParsedRequest;
}

const eventFrame = (obj: unknown) => encodeMessage({ ":message-type": "event", ":event-type": "x" }, enc.encode(JSON.stringify(obj)));
function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < frames.length) c.enqueue(frames[i++]);
      else c.close();
    },
  });
}

async function doneUsage(adapter: ReturnType<typeof createKiroAdapter>, ...frames: Uint8Array[]): Promise<{ inputTokens: number; outputTokens: number }> {
  let done: { inputTokens: number; outputTokens: number } | undefined;
  for await (const e of adapter.parseStream(new Response(streamOf(...frames)))) {
    if (e.type === "done") done = e.usage;
  }
  expect(done).toBeDefined();
  return done!;
}

describe("kiro adapter — buildRequest", () => {
  test("headers carry Bearer token + CW targets", () => {
    const { url, method, headers } = createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(url).toBe("https://runtime.us-east-1.kiro.dev/");
    expect(method).toBe("POST");
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers["x-amz-target"]).toBe("AmazonCodeWhispererStreamingService.GenerateAssistantResponse");
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
  });

  test("toolUses[].input is a JSON object (not stringified) and toolResults are adjacent", () => {
    const messages = [
      { role: "user", content: "run it" },
      { role: "assistant", content: [{ type: "toolCall", id: "call|1", name: "bash", arguments: { command: "echo hi" } }] },
      { role: "toolResult", toolCallId: "call|1", toolName: "bash", content: "hi", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const cs = JSON.parse(body).conversationState;
    const arm = cs.history.find((h: { assistantResponseMessage?: unknown }) => h.assistantResponseMessage)?.assistantResponseMessage;
    const tu = arm.toolUses[0];
    expect(typeof tu.input).toBe("object");
    expect(tu.input).toEqual({ command: "echo hi" });
    expect(tu.toolUseId).toBe("call_1"); // normalized
    const results = cs.currentMessage.userInputMessage.userInputMessageContext.toolResults;
    expect(results[0].toolUseId).toBe("call_1"); // matches the toolUse id
    expect(results[0].status).toBe("success");
  });

  test("tools map to toolSpecification with name<=64", () => {
    const { body } = createKiroAdapter(provider).buildRequest(
      parsedWith([{ role: "user", content: "hi" }], [{ name: "grep", description: "search", parameters: { type: "object" } }]),
    );
    const ctx = JSON.parse(body).conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(ctx.tools[0].toolSpecification.name).toBe("grep");
    expect(ctx.tools[0].toolSpecification.inputSchema.json).toEqual({ type: "object" });
  });
});

describe("kiro adapter — parseStream", () => {
  test("maps CW events (name repeated on every tool chunk) to AdapterEvents with accumulated args", async () => {
    const frames = [
      eventFrame({ content: "Hi " }),
      eventFrame({ content: "there" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"command":"ec', name: "bash", toolUseId: "t1" }),
      eventFrame({ input: 'ho hi"}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const events: string[] = [];
    let args = "";
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(...frames)))) {
      if (e.type === "text_delta") events.push(`text:${e.text}`);
      else if (e.type === "tool_call_start") events.push(`start:${e.id}:${e.name}`);
      else if (e.type === "tool_call_delta") { args += e.arguments; events.push("delta"); }
      else events.push(e.type);
    }
    expect(events).toEqual(["text:Hi ", "text:there", "start:t1:bash", "delta", "delta", "tool_call_end", "done"]);
    expect(JSON.parse(args)).toEqual({ command: "echo hi" });
  });

  test("emits error for an exception frame", async () => {
    const frame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(frame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out[0]).toBe("error:rate limited");
  });

  test("exception frame is terminal: no trailing done", async () => {
    // error frame followed by a (would-be) content frame + would-be normal end.
    const errFrame = encodeMessage({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, enc.encode("rate limited"));
    const contentFrame = eventFrame({ content: "leaked text" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(errFrame, contentFrame)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["error:rate limited"]);
    expect(out).not.toContain("done");
    expect(out).not.toContain("text_delta");
  });

  test("exception mid-stream closes an open tool call then stops", async () => {
    const start = eventFrame({ name: "shell", toolUseId: "tu_1" });
    const errFrame = encodeMessage({ ":message-type": "error", ":error-type": "InternalServerException" }, enc.encode("boom"));
    const tail = eventFrame({ content: "should not appear" });
    const out: string[] = [];
    for await (const e of createKiroAdapter(provider).parseStream(new Response(streamOf(start, errFrame, tail)))) {
      out.push(e.type === "error" ? `error:${e.message}` : e.type);
    }
    expect(out).toEqual(["tool_call_start", "tool_call_end", "error:boom"]);
    expect(out).not.toContain("done");
  });

  test("done carries heuristic usage (input from current turn, output from streamed text)", async () => {
    const adapter = createKiroAdapter(provider);
    // buildRequest first so the per-request closure captures the input estimate + modelId.
    adapter.buildRequest(parsedWith([{ role: "user", content: "x".repeat(700) }]));
    const frames = [eventFrame({ content: "y".repeat(350) })];
    const done = await doneUsage(adapter, ...frames);
    // input: current user message only, 700 chars / 3.5 = 200 tokens.
    expect(done.inputTokens).toBe(200);
    // output: 350 chars / 3.5 = 100 tokens (claude-sonnet-4.5 → kiro 3.5 ratio).
    expect(done.outputTokens).toBe(100);
  });

  test("fresh payload includes history while usage counts only the current turn", async () => {
    const latest = "please summarize recent commits";
    const shortMessages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: latest },
    ];
    const longMessages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: "another old question" },
      { role: "assistant", content: [{ type: "text", text: "another old answer" }] },
      { role: "user", content: latest },
    ];

    const shortAdapter = createKiroAdapter(provider);
    const shortBody = shortAdapter.buildRequest(parsedWith(shortMessages)).body;
    const shortUsage = await doneUsage(shortAdapter, eventFrame({ content: "ok" }));

    const longAdapter = createKiroAdapter(provider);
    const longBody = longAdapter.buildRequest(parsedWith(longMessages)).body;
    const longUsage = await doneUsage(longAdapter, eventFrame({ content: "ok" }));

    expect(longBody.length).toBeGreaterThan(shortBody.length + 10_000);
    expect(longUsage.inputTokens).toBe(shortUsage.inputTokens);
    expect(longUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
  });

  test("resumed payload sends only the current turn instead of repeated history", async () => {
    const latest = "please summarize recent commits";
    const oldHistory = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(8000) }] },
      { role: "user", content: "another old question" },
      { role: "assistant", content: [{ type: "text", text: "another old answer" }] },
    ];

    const freshBody = createKiroAdapter(provider).buildRequest(parsedWith([...oldHistory, { role: "user", content: latest }])).body;
    const resumedAdapter = createKiroAdapter(provider);
    const resumedBody = resumedAdapter.buildRequest({
      ...parsedWith([...oldHistory, { role: "user", content: latest }]),
      previousResponseId: "kiro-prev-1",
    }).body;
    const resumedUsage = await doneUsage(resumedAdapter, eventFrame({ content: "ok" }));
    const cs = JSON.parse(resumedBody).conversationState;

    expect(freshBody.length).toBeGreaterThan(resumedBody.length + 10_000);
    expect(cs.history).toBeUndefined();
    expect(cs.currentMessage.userInputMessage.content).toBe(latest);
    expect(resumedUsage.inputTokens).toBe(estimateTokens(latest, "claude-sonnet-4.5"));
  });

  test("tool-result follow-up counts new tool output without re-counting prior assistant tool args", async () => {
    const hugeArgs = { command: "x".repeat(8000) };
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: hugeArgs }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "done", isError: false },
    ];

    const adapter = createKiroAdapter(provider);
    const body = adapter.buildRequest(parsedWith(messages)).body;
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));

    expect(body).toContain("x".repeat(8000));
    expect(usage.inputTokens).toBeLessThan(50);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("resumed tool-result payload preserves the matching assistant toolUse context", async () => {
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest({ ...parsedWith(messages), previousResponseId: "kiro-prev-1" });
    const cs = JSON.parse(body).conversationState;

    expect(cs.history).toHaveLength(2);
    expect(cs.history[0].userInputMessage.content).toBe("run a command");
    expect(cs.history[1].assistantResponseMessage.toolUses).toEqual([
      { name: "bash", input: { command: "pwd" }, toolUseId: "call-1" },
    ]);
    expect(cs.currentMessage.userInputMessage.content).toBe("(tool results)");
    expect(cs.currentMessage.userInputMessage.userInputMessageContext.toolResults).toEqual([
      { content: [{ text: "/tmp" }], status: "success", toolUseId: "call-1" },
    ]);
  });

  test("resumed tool-result usage remains current-turn only after payload repair", async () => {
    const messages = [
      { role: "user", content: "u".repeat(8000) },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "x".repeat(8000) } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "done", isError: false },
    ];
    const adapter = createKiroAdapter(provider);
    adapter.buildRequest({ ...parsedWith(messages), previousResponseId: "kiro-prev-1" });
    const usage = await doneUsage(adapter, eventFrame({ content: "ok" }));

    expect(usage.inputTokens).toBeLessThan(50);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });
});

describe("kiro adapter — parseResponse (web-search sidecar non-streaming path)", () => {
  test("adapter exposes parseResponse so the web_search sidecar accepts kiro", () => {
    // Regression: a Codex request carrying the web_search tool routes through the non-streaming
    // sidecar loop, which 500s ("requires a non-streaming adapter") if parseResponse is absent.
    expect(typeof createKiroAdapter(provider).parseResponse).toBe("function");
  });

  test("drains the same CW eventstream into an AdapterEvent[] (parity with parseStream)", async () => {
    const frames = [
      eventFrame({ content: "Hi " }),
      eventFrame({ content: "there" }),
      eventFrame({ name: "bash", toolUseId: "t1" }),
      eventFrame({ input: '{"q":1}', name: "bash", toolUseId: "t1" }),
      eventFrame({ name: "bash", stop: true, toolUseId: "t1" }),
    ];
    const events = await createKiroAdapter(provider).parseResponse!(new Response(streamOf(...frames)));
    expect(events.map(e => e.type)).toEqual([
      "text_delta", "text_delta", "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    const start = events.find(e => e.type === "tool_call_start") as { id: string; name: string };
    expect(start).toMatchObject({ id: "t1", name: "bash" });
  });
});

describe("kiro adapter — fake reasoning effort tags", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;

  test("kiro advertises Codex-compatible reasoning efforts", () => {
    expect(kiro).toBeTruthy();
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.8")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(configuredReasoningEfforts(kiro, "kiro-auto")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("mapReasoningEffort keeps Codex xhigh rather than advertising max", () => {
    expect(mapReasoningEffort(kiro, "claude-opus-4.8", "xhigh")).toBe("xhigh");
    expect(mapReasoningEffort(kiro, "deepseek-3.2", "max")).toBe("xhigh");
  });

  test("xhigh injects current-message thinking tags with a 95% output-token budget", () => {
    const { body } = createKiroAdapter(provider).buildRequest({
      ...parsedWith([{ role: "user", content: "solve it" }]),
      options: { reasoning: "xhigh", maxOutputTokens: 8000 },
    });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("<thinking_mode>enabled</thinking_mode>");
    expect(content).toContain("<max_thinking_length>7600</max_thinking_length>");
    expect(content).toContain("solve it");
  });

  test("reasoning tags are not injected into tool-result carrier turns", () => {
    const messages = [
      { role: "user", content: "run a command" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "/tmp", isError: false },
    ];
    const { body } = createKiroAdapter(provider).buildRequest({ ...parsedWith(messages), options: { reasoning: "high" } });
    const content = JSON.parse(body).conversationState.currentMessage.userInputMessage.content;

    expect(content).toBe("(tool results)");
    expect(content).not.toContain("<thinking_mode>");
  });
});

describe("kiro adapter — per-model context windows (kiro.dev/docs/models)", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;
  const cw = kiro.modelContextWindows ?? {};

  test("1M-context models map to 1_000_000", () => {
    for (const id of ["claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-sonnet-4.6"]) {
      expect(cw[id]).toBe(1_000_000);
    }
  });

  test("smaller-context models match Kiro's published limits", () => {
    expect(cw["claude-sonnet-4.5"]).toBe(200_000);
    expect(cw["claude-haiku-4.5"]).toBe(200_000);
    expect(cw["minimax-m2.5"]).toBe(200_000);
    expect(cw["glm-5"]).toBe(200_000);
    expect(cw["deepseek-3.2"]).toBe(128_000);
    expect(cw["qwen3-coder-next"]).toBe(256_000);
  });

  test("Auto router has no fixed window (omitted)", () => {
    expect(cw["kiro-auto"]).toBeUndefined();
  });
});
