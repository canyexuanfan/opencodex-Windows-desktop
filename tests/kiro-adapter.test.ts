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

  test("usage input does not grow with old history while Kiro payload still includes it", async () => {
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

describe("kiro adapter — reasoning ignored (Codex forces it, CW has no field)", () => {
  const kiro = PROVIDER_REGISTRY.find(p => p.id === "kiro") as unknown as OcxProviderConfig;

  test("kiro is registered with no-reasoning metadata", () => {
    expect(kiro).toBeTruthy();
    expect(kiro.noReasoningModels?.length).toBeGreaterThan(0);
  });

  test("configuredReasoningEfforts is [] for kiro models (catalog advertises none)", () => {
    expect(configuredReasoningEfforts(kiro, "claude-opus-4.8")).toEqual([]);
    expect(configuredReasoningEfforts(kiro, "kiro-auto")).toEqual([]);
  });

  test("mapReasoningEffort drops any Codex-forced effort for kiro models", () => {
    for (const eff of ["low", "medium", "high", "xhigh", "max", "minimal"]) {
      expect(mapReasoningEffort(kiro, "claude-opus-4.8", eff)).toBeUndefined();
      expect(mapReasoningEffort(kiro, "deepseek-3.2", eff)).toBeUndefined();
    }
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
