/**
 * #1700: the native Responses passthrough relayed a routed provider's call to a tool the request
 * never declared. Codex has no top-level handler for it, so the turn surfaced as a bare `aborted`
 * with the target file untouched. The bridged paths already fail closed on the same condition
 * (`declaredToolNames`, src/bridge.ts); these pin the passthrough's equivalent.
 */
import { describe, expect, test } from "bun:test";
import {
  collectDeclaredWireToolNames,
  createUndeclaredToolCallGuardBlockRewrite,
  undeclaredToolCallNameInResponse,
  UNDECLARED_TOOL_CALL_ERROR_CODE,
} from "../src/server/responses-undeclared-tool-guard";
import { relaySseWithBlockRewrite } from "../src/server/sse-payload-rewrite";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

/** One SSE event block without its blank-line delimiter. */
function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}`;
}

/** One SSE event block including its delimiter, ready to concatenate. */
function sse(type: string, payload: Record<string, unknown>): string {
  return `${frame(type, payload)}\n\n`;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function relay(upstream: string, declared: Iterable<string>): Promise<string> {
  const budget = createTestTranslatorBudget();
  try {
    return await readAll(relaySseWithBlockRewrite(
      streamFromText(upstream),
      createUndeclaredToolCallGuardBlockRewrite(new Set(declared)),
      budget,
    ));
  } finally {
    budget.dispose();
  }
}

describe("collectDeclaredWireToolNames", () => {
  test("reads function, custom, and namespaced tools off the outbound body", () => {
    const names = collectDeclaredWireToolNames({
      tools: [
        { type: "function", name: "exec" },
        { type: "custom", name: "apply_patch" },
        { type: "namespace", name: "linear", tools: [{ type: "function", name: "create_issue" }] },
        { type: "web_search" },
      ],
    });

    // Namespaced MCP tools are reachable under either coordinate system, so both are accepted.
    expect([...names].sort()).toEqual(
      ["apply_patch", "create_issue", "exec", "linear__create_issue"],
    );
  });

  test("reads tools carried inside input as an additional_tools item", () => {
    // Codex Desktop's responses_lite WS path ships the catalog there instead of body.tools.
    const names = collectDeclaredWireToolNames({
      input: [
        { type: "message", role: "user", content: [] },
        { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "wait" }] },
      ],
    });

    expect([...names]).toEqual(["wait"]);
  });

  test("is empty for a body this proxy could not read", () => {
    expect(collectDeclaredWireToolNames(undefined).size).toBe(0);
    expect(collectDeclaredWireToolNames({ tools: "nonsense" }).size).toBe(0);
  });
});

describe("undeclared tool call guard", () => {
  const declared = ["exec", "wait", "request_user_input"];

  test("relays a declared call untouched", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec", arguments: "{}" },
    }) + sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } });

    expect(await relay(upstream, declared)).toBe(upstream);
  });

  test("replaces an undeclared apply_patch with a compatibility failure", async () => {
    // The reported shape: the request-visible catalog holds exec/wait/request_user_input, and
    // `apply_patch` arrives anyway because code mode nests it inside the exec description.
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain("event: response.failed");
    expect(out).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(out).toContain('routed provider emitted undeclared client tool \\"apply_patch\\"');
    expect(out).toEndWith("data: [DONE]\n\n");
  });

  test("drops the rest of the turn so a later completed cannot contradict the failure", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "" },
    })
      + sse("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"input\":\"" })
      + sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } })
      + "data: [DONE]\n\n";

    const out = await relay(upstream, declared);
    expect(out).not.toContain("response.completed");
    expect(out).not.toContain("function_call_arguments");
    expect(out.match(/\[DONE\]/g)).toHaveLength(1);
  });

  test("catches the snapshot-only shape, where no item event is ever streamed", async () => {
    const upstream = sse("response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "message", id: "msg_0", role: "assistant" },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "{}" },
        ],
      },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(out).not.toContain('"status":"completed"');
  });

  test("accepts a namespaced call echoed under its bare name", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "create_issue",
        namespace: "linear",
        arguments: "{}",
      },
    });

    expect(await relay(upstream, ["linear__create_issue"])).toBe(upstream);
  });

  test("never blocks apply_patch when the request really declared it", async () => {
    // `apply_patch` is exempt from the routed custom-tool rewrite, so it reaches upstream as
    // `{type:"custom"}` and comes back as a `custom_tool_call`. A request that declares it must
    // keep working — the guard exists for the case where the catalog never mentioned it.
    const outbound = { tools: [{ type: "custom", name: "apply_patch" }, { type: "function", name: "exec" }] };
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "apply_patch", input: "" },
    });

    expect(await relay(upstream, collectDeclaredWireToolNames(outbound))).toBe(upstream);
  });

  test("ignores upstream-executed calls, which are never matched against the catalog", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "web_search_call", id: "ws_1", status: "completed" },
    }) + sse("response.output_item.added", {
      output_index: 1,
      item: { type: "tool_search_call", id: "tsc_1", status: "completed" },
    });

    expect(await relay(upstream, declared)).toBe(upstream);
  });

  test("leaves comment frames, [DONE], and unparseable payloads alone", async () => {
    const upstream = ": keep-alive\n\ndata: {not json\n\ndata: [DONE]\n\n";

    expect(await relay(upstream, declared)).toBe(upstream);
  });

  test("bounds a hostile tool name before it reaches the error message", async () => {
    const upstream = sse("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "x".repeat(5_000), arguments: "{}" },
    });

    const out = await relay(upstream, declared);
    expect(out).toContain(`\\"${"x".repeat(100)}\\"`);
    expect(out).not.toContain("x".repeat(101));
  });
});

describe("the reported turn, end to end through handleResponses", () => {
  // The report's setup: provider `opencode-go`, a model pinned to the openai-responses adapter,
  // and a Codex catalog of exec/wait/request_user_input with no top-level apply_patch schema.
  const config = {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://fixture.test/v1",
        authMode: "key",
        apiKey: "fixture-key",
      },
    },
  } as OcxConfig;

  const requestBody = (stream: boolean) => JSON.stringify({
    model: "fixture/deepseek-v4-flash",
    stream,
    input: [{ role: "user", content: [{ type: "input_text", text: "change v1 to v2" }] }],
    tools: [
      { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
      { type: "function", name: "wait", parameters: { type: "object" } },
      { type: "function", name: "request_user_input", parameters: { type: "object" } },
    ],
  });

  const leakedCall = {
    type: "function_call",
    id: "fc_patch",
    call_id: "call_patch",
    name: "apply_patch",
    arguments: "{\"input\":\"*** Begin Patch\"}",
    status: "completed",
  };

  async function post(stream: boolean, upstream: () => Response): Promise<Response> {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => upstream()) as typeof fetch;
    try {
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody(stream),
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  test("streaming: the leaked apply_patch becomes a named failure instead of a silent abort", async () => {
    const response = await post(true, () => new Response([
      frame("response.output_item.added", { output_index: 0, item: { ...leakedCall, arguments: "", status: "in_progress" } }),
      frame("response.output_item.done", { output_index: 0, item: leakedCall }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [leakedCall] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }));

    const body = await response.text();
    expect(body).toContain("response.failed");
    expect(body).toContain(`"code":"${UNDECLARED_TOOL_CALL_ERROR_CODE}"`);
    expect(body).toContain("apply_patch");
    // Before the guard this reached Codex as a call it has no handler for, and the turn showed
    // only `aborted`. The client must not see a completed turn now.
    expect(body).not.toContain("response.completed");
  });

  test("non-streaming: the same call is refused rather than answered", async () => {
    const response = await post(false, () => new Response(
      JSON.stringify({ id: "resp_1", status: "completed", output: [leakedCall] }),
      { headers: { "content-type": "application/json" } },
    ));

    expect(response.status).toBe(502);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain('undeclared client tool "apply_patch"');
  });

  test("a declared exec call still completes normally", async () => {
    const execCall = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"await tools.apply_patch('*** Begin Patch')\"}",
      status: "completed",
    };
    const response = await post(false, () => new Response(
      JSON.stringify({ id: "resp_1", status: "completed", output: [execCall] }),
      { headers: { "content-type": "application/json" } },
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    // `exec` is declared as a custom tool, so it comes back restored to a custom_tool_call —
    // the supported editing path in the report stays intact.
    expect(body.output[0]).toMatchObject({ name: "exec", call_id: "call_exec" });
  });
});

describe("undeclaredToolCallNameInResponse", () => {
  test("names the first undeclared call in a non-streaming body", () => {
    const response = {
      output: [
        { type: "function_call", name: "exec" },
        { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" },
      ],
    };

    expect(undeclaredToolCallNameInResponse(response, new Set(["exec"]))).toBe("apply_patch");
    expect(undeclaredToolCallNameInResponse(response, new Set(["exec", "apply_patch"]))).toBeUndefined();
  });
});
