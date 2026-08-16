/**
 * #1735: a Gemini thought signature must survive a HISTORY-driven turn, where the same-process
 * replay cache is not available — the exact case the cache was masking.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { __resetAntigravityReplayCache } from "../src/adapters/google-antigravity-replay";
import { parseRequest } from "../src/responses/parser";
import {
  flushThoughtSignatureReplayForTests,
  lookupReplayThoughtSignature,
  rememberThoughtSignatureForReplay,
  resetThoughtSignatureReplayForTests,
} from "../src/responses/thought-signature-replay";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const SIGNATURE = "CiQAx-history-thought-signature-0123456789abcdef";
const SIGNATURE_B = "CiQAx-history-thought-signature-second-call-99";
const MODEL = "gemini-3.6-flash";

const provider = {
  adapter: "google",
  googleMode: "vertex",
  baseUrl: "https://aiplatform.googleapis.com",
  apiKey: "vertex-test-key",
} as OcxProviderConfig;

function firstTurn(): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream: false,
    context: {
      messages: [{ role: "user", content: "run pwd" }],
      systemPrompt: [],
      tools: [{ name: "shell_command", description: "run a command", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

function googleBody(parts: Record<string, unknown>[]): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
}

function modelParts(body: string): Record<string, unknown>[] {
  const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
  return parsed.contents.find(content => content.role === "model")?.parts ?? [];
}

describe("#1735 thought signature survives history replay", () => {
  let previousHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    __resetAntigravityReplayCache();
    resetThoughtSignatureReplayForTests();
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-thought-sig-"));
    process.env.OPENCODEX_HOME = testDir;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  test("the adapter attaches the signature to the tool call that produced it", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { functionCall: { name: "shell_command", args: { command: "pwd" } }, thoughtSignature: SIGNATURE },
    ]))));
    const start = events.find((e: AdapterEvent) => e.type === "tool_call_start");
    expect(start && "providerMetadata" in start ? start.providerMetadata?.google?.thoughtSignature : undefined)
      .toBe(SIGNATURE);
  });

  test("parallel calls each keep their own signature", async () => {
    const adapter = createGoogleAdapter(provider);
    await adapter.buildRequest(firstTurn());
    const events = await adapter.parseResponse!(new Response(JSON.stringify(googleBody([
      { functionCall: { name: "shell_command", args: { command: "pwd" } }, thoughtSignature: SIGNATURE },
      { functionCall: { name: "shell_command", args: { command: "ls" } }, thoughtSignature: SIGNATURE_B },
    ]))));
    const signatures = events
      .filter((e: AdapterEvent) => e.type === "tool_call_start")
      .map((e: AdapterEvent) => ("providerMetadata" in e ? e.providerMetadata?.google?.thoughtSignature : undefined));
    // Neither signature may migrate onto the other call.
    expect(signatures).toEqual([SIGNATURE, SIGNATURE_B]);
  });

  test("a signature replayed through Responses history reaches the rebuilt Google part", async () => {
    // No cache is warmed here: this is a cold process replaying client-supplied history.
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        {
          type: "function_call",
          call_id: "call_shell_1",
          name: "shell_command",
          arguments: JSON.stringify({ command: "pwd" }),
          extra_content: { google: { thought_signature: SIGNATURE } },
        },
        { type: "function_call_output", call_id: "call_shell_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });

    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("history without a signature stays unsigned rather than borrowing one", async () => {
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_shell_1", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_shell_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBeUndefined();
  });

  test("a signature the proxy remembered re-signs a replay the client sent without extra_content", async () => {
    // The proxy handed out SIGNATURE for call_shell_9 in a previous turn; the client replays
    // the call as a bare function_call item (codex-rs/desktop never echo extra_content).
    rememberThoughtSignatureForReplay("call_shell_9", SIGNATURE);
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_shell_9", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_shell_9", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE);
  });

  test("a custom_tool_call replay is re-signed from the proxy-side store", async () => {
    rememberThoughtSignatureForReplay("call_custom_1", SIGNATURE_B);
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "custom_tool_call", call_id: "call_custom_1", name: "shell_command", input: JSON.stringify({ command: "pwd" }) },
        { type: "custom_tool_call_output", call_id: "call_custom_1", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBe(SIGNATURE_B);
  });

  test("an unknown call_id stays unsigned", async () => {
    const parsed = parseRequest({
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "function_call", call_id: "call_never_seen", name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) },
        { type: "function_call_output", call_id: "call_never_seen", output: "/workspace" },
      ],
      tools: [{ type: "function", name: "shell_command", description: "run", parameters: { type: "object" } }],
    });
    const request = await createGoogleAdapter(provider).buildRequest(parsed);
    const part = modelParts(request.body as string).find(candidate => "functionCall" in candidate);
    expect(part?.thoughtSignature).toBeUndefined();
  });

  test("the proxy-side store survives a process restart via its snapshot", async () => {
    rememberThoughtSignatureForReplay("call_disk_1", SIGNATURE);
    await flushThoughtSignatureReplayForTests();
    // Simulate a fresh process: drop in-memory state; lookup must reload from disk.
    resetThoughtSignatureReplayForTests();
    expect(lookupReplayThoughtSignature("call_disk_1")).toBe(SIGNATURE);
  });
});
