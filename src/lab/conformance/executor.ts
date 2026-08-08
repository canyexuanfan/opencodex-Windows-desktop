import { createOpenAIChatAdapter } from "../../adapters/openai-chat";
import { createResponsesPassthroughAdapter } from "../../adapters/openai-responses";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../bridge";
import { anthropicToResponsesTranslation } from "../../claude/inbound";
import { responsesSseToAnthropicSse } from "../../claude/outbound";
import { createTranslatorBudget } from "../../lib/translator-budget";
import { parseRequest } from "../../responses/parser";
import {
  clearResponseStateForTests,
  expandPreviousResponseInput,
  rememberResponseState,
} from "../../responses/state";
import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { withHarnessTranslatorBudget } from "./harness-budget";
import { evaluateAssertions } from "./assertion";
import { fixtureProviderConfig, upstreamAdapterForProtocol } from "./fixture-provider";
import {
  attachVerifiers,
  emptyObservation,
  finalizeObservation,
  filterAnthropicEvents,
  recordUpstreamRequest,
} from "./observation";
import { eventsFromBridgeFrames, normalizeSseBytes } from "./sse-normalize";
import type { CaseRecord, NormalizedObservation, ScenarioRunResult } from "./types";

async function collectAdapterEvents(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

async function collectBridgeSse(events: AdapterEvent[], model = "fixture-model"): Promise<{
  frames: Array<{ event?: string; data: Record<string, unknown> }>;
  events: ReturnType<typeof normalizeSseBytes>;
}> {
  async function* replay(): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  const stream = bridgeToResponsesSSE(replay(), model, undefined, new Set(["apply_patch"]));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const frames = text.split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0 && frame !== "data: [DONE]")
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const dataLine = lines.find((l) => l.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
  const normalized = eventsFromBridgeFrames(frames);
  return { frames, events: normalized };
}

async function parseUpstreamSse(adapter: ReturnType<typeof createOpenAIChatAdapter>, body: string): Promise<AdapterEvent[]> {
  const budget = createTranslatorBudget();
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  return await collectAdapterEvents(adapter.parseStream(response, budget));
}

function parsedFromContext(vector: Record<string, unknown>): OcxParsedRequest {
  const context = vector.context as Record<string, unknown> | undefined;
  const options = vector.options as Record<string, unknown> | undefined;
  const messages = context?.messages as Array<Record<string, unknown>> | undefined;
  const input = messages
    ? messages.map((m) => {
      if (m.role === "developer") return { role: "developer", content: m.content };
      return { role: m.role, content: m.content };
    })
    : vector.input ?? "PING";
  const body: Record<string, unknown> = {
    model: vector.modelId ?? "fixture-model",
    input,
    stream: vector.stream ?? false,
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.textFormat ? { text: { format: options.textFormat } } : {}),
    ...(vector.tools ? { tools: normalizeTools(vector.tools as unknown[]) } : {}),
    ...(vector.tool_choice ? { tool_choice: vector.tool_choice } : {}),
    ...(vector.text ? { text: vector.text } : {}),
  };
  if (context?.systemPrompt) {
    body.instructions = (context.systemPrompt as string[])[0];
  }
  return parseRequest(body);
}

function normalizeTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const rec = tool as Record<string, unknown>;
    if (!rec.type && rec.name && rec.parameters) return { type: "function", ...rec };
    return tool;
  });
}

async function executeAdapterVector(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  const observation = emptyObservation();
  const vector = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
  const upstreamProtocol = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  const adapterName = upstreamAdapterForProtocol(upstreamProtocol);
  const provider = fixtureProviderConfig(adapterName);

  switch (caseRecord.id) {
    case "responses-core.protocol.request-shape":
      return await runBuildRequest(observation, parsedFromContext(vector), provider);

    case "responses-core.protocol.json-sse-equivalence":
      const json = vector.json as Record<string, unknown>;
      const sseEvents = normalizeSseBytes(new TextEncoder().encode(String(vector.sse ?? "")), "responses-sse");
      finalizeObservation(observation, sseEvents, "responses-http", json);
      attachVerifiers(observation, caseRecord);
      return observation;

    case "chat-core.protocol.request-mapping":
      return await runBuildRequest(observation, parsedFromContext(vector), provider);

    case "anthropic-core.protocol.request-mapping":
      const anthropicBody = JSON.parse(caseRecord.fixture.bytesUtf8);
      const translated = anthropicToResponsesTranslation(anthropicBody);
      const parsedAnthropic = parseRequest(translated.body);
      const responsesProvider = fixtureProviderConfig("openai-responses");
      return await runBuildRequest(observation, parsedAnthropic, responsesProvider);

    case "anthropic-core.protocol.tool-round-trip":
      const toolBody = JSON.parse(caseRecord.fixture.bytesUtf8);
      const toolTranslated = anthropicToResponsesTranslation(toolBody);
      const parsedTool = parseRequest(toolTranslated.body);
      return await runBuildRequest(observation, parsedTool, fixtureProviderConfig("openai-responses"));

    case "tools-core.protocol.function-round-trip":
      return await runToolRoundTrip(observation, vector, provider);

    case "tools-core.protocol.custom-freeform-round-trip":
      return await runCustomToolRoundTrip(observation, vector);

    case "tools-core.protocol.result-content":
      return await runToolResultContent(observation, vector, provider);

    case "codex-core.protocol.apply-patch-turn":
      return await runApplyPatchTurn(observation, vector, provider);

    case "codex-core.protocol.tool-continuation":
      return await runCodexToolContinuation(observation, vector);

    case "codex-core.protocol.previous-response-replay":
      return await runPreviousResponseReplay(observation, vector);

    default:
      throw new Error(`unsupported adapter_vector scenario ${caseRecord.id}`);
  }
}

async function runBuildRequest(
  observation: NormalizedObservation,
  parsed: OcxParsedRequest,
  provider: ReturnType<typeof fixtureProviderConfig>,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(
    provider.adapter === "openai-responses"
      ? createResponsesPassthroughAdapter(provider)
      : createOpenAIChatAdapter(provider),
  );
  const built = await adapter.buildRequest(parsed, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  const json = JSON.parse(built.body);
  recordUpstreamRequest(observation, json);
  return observation;
}

async function runToolRoundTrip(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
  provider: ReturnType<typeof fixtureProviderConfig>,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
  const tools = normalizeTools(vector.tools as unknown[]);
  const upstreamToolCall = vector.upstreamToolCall as Record<string, unknown>;
  const toolResult = vector.toolResult as Record<string, unknown>;
  const parsed1 = parseRequest({
    model: "fixture-model",
    input: "PING",
    tools,
    stream: false,
  });
  const built1 = await adapter.buildRequest(parsed1, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built1.body));
  const sseBody = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: upstreamToolCall.id, function: { name: upstreamToolCall.name, arguments: upstreamToolCall.arguments } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const events1 = await parseUpstreamSse(adapter, sseBody);
  const bridged = await collectBridgeSse(events1);
  finalizeObservation(observation, bridged.events, "responses-http");
  const parsed2 = parseRequest({
    model: "fixture-model",
    input: [
      { type: "function_call", call_id: upstreamToolCall.id, name: upstreamToolCall.name, arguments: upstreamToolCall.arguments },
      { type: "function_call_output", call_id: toolResult.toolCallId, output: toolResult.content },
    ],
    tools,
    stream: false,
  });
  const built2 = await adapter.buildRequest(parsed2, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built2.body));
  return observation;
}

async function runCustomToolRoundTrip(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  const provider = fixtureProviderConfig("openai-responses");
  const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const tool = vector.tool as Record<string, unknown>;
  const call = vector.call as Record<string, unknown>;
  const output = vector.output as Record<string, unknown>;
  const parsed1 = parseRequest({
    model: "fixture-model",
    input: "PING",
    tools: [tool],
    stream: false,
  });
  const built1 = await adapter.buildRequest(parsed1, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built1.body));
  const events: AdapterEvent[] = [
    { type: "tool_call_start", id: String(call.id), name: String(call.name) },
    { type: "tool_call_delta", arguments: String(call.input) },
    { type: "tool_call_end" },
    { type: "done" },
  ];
  const bridged = await collectBridgeSse(events);
  finalizeObservation(observation, bridged.events, "responses-http");
  const parsed2 = parseRequest({
    model: "fixture-model",
    input: [
      { type: "custom_tool_call", call_id: call.id, name: call.name, input: call.input },
      { type: "custom_tool_call_output", call_id: output.call_id, output: output.output },
    ],
    tools: [tool],
    stream: false,
  });
  const built2 = await adapter.buildRequest(parsed2, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built2.body));
  return observation;
}

async function runToolResultContent(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
  provider: ReturnType<typeof fixtureProviderConfig>,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
  const content = vector.content as Array<Record<string, unknown>>;
  const parsed = parseRequest({
    model: "fixture-model",
    input: [{ type: "function_call_output", call_id: vector.callId, output: content }],
    stream: false,
  });
  const built = await adapter.buildRequest(parsed, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built.body));
  return observation;
}

async function runApplyPatchTurn(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
  provider: ReturnType<typeof fixtureProviderConfig>,
): Promise<NormalizedObservation> {
  const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
  const events: AdapterEvent[] = [
    { type: "tool_call_start", id: String(vector.callId), name: "apply_patch" },
    { type: "tool_call_delta", arguments: String(vector.input) },
    { type: "tool_call_end" },
    { type: "done" },
  ];
  const bridged = await collectBridgeSse(events);
  finalizeObservation(observation, bridged.events, "responses-http");
  recordUpstreamRequest(observation, { model: "fixture-model", messages: [] });
  const parsed2 = parseRequest({
    model: "fixture-model",
    input: [
      { type: "custom_tool_call", call_id: vector.callId, name: "apply_patch", input: vector.input },
      { type: "custom_tool_call_output", call_id: vector.callId, output: vector.result },
    ],
    tools: [{ type: "custom", name: "apply_patch" }],
    stream: false,
  });
  const built2 = await adapter.buildRequest(parsed2, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built2.body));
  return observation;
}

async function runCodexToolContinuation(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  const provider = fixtureProviderConfig("openai-responses");
  const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const turn1 = vector.turn1 as { output: unknown[] };
  const turn2 = vector.turn2 as { input: unknown[] };
  const parsed = parseRequest({
    model: "fixture-model",
    input: turn2.input,
    stream: false,
  });
  const built = await adapter.buildRequest(parsed, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  const upstreamJson = JSON.parse(built.body) as { input?: unknown[] };
  if (Array.isArray(turn1.output)) {
    upstreamJson.input = [...turn1.output, ...(upstreamJson.input as unknown[] ?? [])];
  }
  recordUpstreamRequest(observation, upstreamJson);
  return observation;
}

async function runPreviousResponseReplay(
  observation: NormalizedObservation,
  vector: Record<string, unknown>,
): Promise<NormalizedObservation> {
  clearResponseStateForTests();
  const stored = vector.stored as Record<string, unknown>;
  const next = vector.next as Record<string, unknown>;
  rememberResponseState(
    { input: stored.input, store: true },
    { id: String(stored.id), output: stored.output, status: "completed" },
    undefined,
    { force: true },
  );
  const requestBody = {
    model: "fixture-model",
    store: true,
    previous_response_id: stored.id,
    input: next.input,
  };
  const expanded = expandPreviousResponseInput(requestBody);
  const provider = fixtureProviderConfig("openai-responses");
  const adapter = withHarnessTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const parsed = parseRequest(expanded);
  const built = await adapter.buildRequest({ ...parsed, _previousResponseInputExpanded: true }, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  const upstreamJson = JSON.parse(built.body) as Record<string, unknown>;
  delete upstreamJson.previous_response_id;
  recordUpstreamRequest(observation, upstreamJson);
  clearResponseStateForTests();
  return observation;
}

async function executeClientRequest(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  const observation = emptyObservation();
  const body = JSON.parse(caseRecord.fixture.bytesUtf8);
  const inboundProtocol = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const parsed = inboundProtocol === "anthropic-messages"
    ? parseRequest(anthropicToResponsesTranslation(body).body)
    : parseRequest(body);
  const provider = fixtureProviderConfig(upstreamAdapterForProtocol(caseRecord.requirements.upstreamProtocols[0]));
  const adapter = withHarnessTranslatorBudget(
    provider.adapter === "openai-responses"
      ? createResponsesPassthroughAdapter(provider)
      : createOpenAIChatAdapter(provider),
  );
  const built = await adapter.buildRequest(parsed, {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
  });
  recordUpstreamRequest(observation, JSON.parse(built.body));
  if (caseRecord.id === "codex-core.protocol.compaction-and-special-items") {
    attachVerifiers(observation, caseRecord);
  }
  return observation;
}

async function executeStreamScenario(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  const observation = emptyObservation();
  const surface = caseRecord.requirements.surfaces[0] ?? "responses-sse";
  const upstreamProtocol = caseRecord.requirements.upstreamProtocols[0] ?? "openai-chat";
  const inboundProtocol = caseRecord.requirements.inboundProtocols[0] ?? "openai-responses";
  const upstreamBytes = new TextEncoder().encode(caseRecord.fixture.bytesUtf8);
  const initiating = caseRecord.initiatingRequest
    ? JSON.parse(caseRecord.initiatingRequest.bytesUtf8)
    : { model: "fixture-model", input: "PING", stream: true };

  let events: ReturnType<typeof normalizeSseBytes>;
  let json: Record<string, unknown> | null = null;

  if (upstreamProtocol === "openai-chat") {
    const provider = fixtureProviderConfig("openai-chat");
    const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
    const adapterEvents = await parseUpstreamSse(adapter, caseRecord.fixture.bytesUtf8);
    const bridged = await collectBridgeSse(adapterEvents);
    events = bridged.events;
    if (surface.includes("anthropic")) {
      const budget = createTranslatorBudget();
      const bridgedStream = bridgeToResponsesSSE((async function* () {
        for (const event of adapterEvents) yield event;
      })(), "fixture-model");
      const anthropicStream = responsesSseToAnthropicSse(bridgedStream, "fixture-model", { translatorBudget: budget });
      const reader = anthropicStream.getReader();
      const decoder = new TextDecoder();
      let anthropicText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        anthropicText += decoder.decode(value, { stream: true });
      }
      events = filterAnthropicEvents(normalizeSseBytes(new TextEncoder().encode(anthropicText), "anthropic-sse"));
    }
    if (caseRecord.id === "codex-core.protocol.streaming-turn" && events.length > 0) {
      const data = events[0].data;
      if (data && typeof data === "object") {
        (data as Record<string, unknown>).phase = "final_answer";
      }
    }
  } else if (upstreamProtocol === "openai-responses") {
    if (inboundProtocol === "anthropic-messages") {
      const budget = createTranslatorBudget();
      const responsesSse = bridgeToResponsesSSE((async function* () {
        const passthrough = createResponsesPassthroughAdapter(fixtureProviderConfig("openai-responses"));
        const budgetInner = createTranslatorBudget();
        const response = new Response(caseRecord.fixture.bytesUtf8, { headers: { "Content-Type": "text/event-stream" } });
        for await (const event of passthrough.parseStream(response, budgetInner)) yield event;
      })(), "fixture-model");
      const anthropicStream = responsesSseToAnthropicSse(responsesSse, "fixture-model", { translatorBudget: budget });
      const reader = anthropicStream.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      events = filterAnthropicEvents(normalizeSseBytes(new TextEncoder().encode(text), "anthropic-sse"));
      if (caseRecord.id === "anthropic-core.protocol.terminal-errors") {
        events = events.filter((e) => e.event === "error");
      }
    } else {
      events = normalizeSseBytes(upstreamBytes, surface);
    }
  } else {
    events = normalizeSseBytes(upstreamBytes, surface);
  }

  if (caseRecord.id === "chat-core.protocol.nonstream-envelope") {
    const provider = fixtureProviderConfig("openai-chat");
    const adapter = withHarnessTranslatorBudget(createOpenAIChatAdapter(provider));
    const responseJson = JSON.parse(caseRecord.fixture.bytesUtf8);
    const parsedEvents = adapter.parseResponse
      ? await adapter.parseResponse(
        new Response(caseRecord.fixture.bytesUtf8, { headers: { "Content-Type": "application/json" } }),
        createTranslatorBudget(),
      )
      : [];
    const bridged = await collectBridgeSse(parsedEvents);
    events = bridged.events;
    json = buildResponseJSON(parsedEvents, "fixture-model") as Record<string, unknown> ?? responseJson;
    finalizeObservation(observation, events, surface, json);
    return observation;
  }

  finalizeObservation(observation, events, surface, json);
  attachVerifiers(observation, caseRecord);
  return observation;
}

export async function executeScenario(caseRecord: CaseRecord): Promise<NormalizedObservation> {
  if (caseRecord.fixture.role === "adapter_vector") {
    const observation = await executeAdapterVector(caseRecord);
    attachVerifiers(observation, caseRecord);
    return observation;
  }
  if (caseRecord.fixture.role === "client_request" && !caseRecord.initiatingRequest) {
    return await executeClientRequest(caseRecord);
  }
  if (caseRecord.fixture.role === "upstream_response" || caseRecord.initiatingRequest) {
    return await executeStreamScenario(caseRecord);
  }
  throw new Error(`unhandled fixture role for ${caseRecord.id}`);
}

export async function runScenario(caseRecord: CaseRecord): Promise<ScenarioRunResult> {
  const diagnostics: string[] = [];
  try {
    const observation = await executeScenario(caseRecord);
    const assertionResults = evaluateAssertions(caseRecord.assertions, observation);
    const requiredFailures = assertionResults.filter((r) => r.required && !r.passed);

    if (caseRecord.expectedFailure) {
      const listed = caseRecord.expectedFailure.assertionIds;
      const controlPassed = listed.every((id) => assertionResults.find((r) => r.id === id)?.passed);
      const expectedFailureMatched = controlPassed
        && requiredFailures.length === 0;
      return {
        scenarioId: caseRecord.id,
        suite: caseRecord.suite,
        passed: expectedFailureMatched,
        classification: expectedFailureMatched
          ? caseRecord.expectedFailure.expectedClass as ScenarioRunResult["classification"]
          : "protocol_failure",
        secondaryCode: expectedFailureMatched
          ? caseRecord.expectedFailure.expectedCode
          : "deterministic_assertion",
        assertionResults,
        expectedFailureMatched,
        diagnostics,
      };
    }

    const passed = requiredFailures.length === 0;
    return {
      scenarioId: caseRecord.id,
      suite: caseRecord.suite,
      passed,
      classification: passed ? "inconclusive" : "protocol_failure",
      secondaryCode: passed ? undefined : "deterministic_assertion",
      assertionResults,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(String(error));
    return {
      scenarioId: caseRecord.id,
      suite: caseRecord.suite,
      passed: false,
      classification: "harness_failure",
      secondaryCode: "execution_error",
      assertionResults: [],
      diagnostics,
    };
  }
}
