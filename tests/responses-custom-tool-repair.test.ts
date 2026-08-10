import { describe, expect, test } from "bun:test";
import {
  collectRoutedCustomToolNames,
  restoreRoutedCustomCallsInJson,
  rewriteRoutedCustomToolsForUpstream,
} from "../src/responses/custom-tool-compat";
import { createRoutedCustomToolRestoreBlockRewrite } from "../src/server/responses-custom-tool-repair";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function dataPayload(block: string): Record<string, unknown> {
  const line = block.split(/\r?\n/).find(entry => entry.startsWith("data:"));
  if (!line) throw new Error("missing SSE data line");
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;
}

describe("routed Responses custom-tool compatibility", () => {
  test("rewrites exec definitions and paired history without touching apply_patch", () => {
    const raw = {
      model: "deepseek-v4-flash",
      tools: [
        { type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } },
        { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark" } },
        { type: "function", name: "ordinary", parameters: { type: "object" } },
      ],
      input: [
        { type: "custom_tool_call", id: "ctc_exec", call_id: "call_exec", name: "exec", input: "await sky.list_apps()" },
        { type: "custom_tool_call_output", call_id: "call_exec", output: "27 apps" },
        { type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done" },
      ],
    };

    expect(collectRoutedCustomToolNames(raw)).toEqual(new Set(["exec"]));
    const rewritten = rewriteRoutedCustomToolsForUpstream(raw);
    expect(rewritten.names).toEqual(new Set(["exec"]));
    expect(rewritten.body).not.toBe(raw);
    expect(raw.tools[0]?.type).toBe("custom");

    const body = rewritten.body as typeof raw;
    expect(body.tools[0]).toMatchObject({
      type: "function",
      name: "exec",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    });
    expect(body.tools[0]).not.toHaveProperty("format");
    expect(body.tools[1]).toEqual(raw.tools[1]);
    expect(body.tools[2]).toEqual(raw.tools[2]);
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_exec",
      name: "exec",
      arguments: JSON.stringify({ input: "await sky.list_apps()" }),
    });
    expect(body.input[0]).not.toHaveProperty("input");
    expect(body.input[1]).toMatchObject({ type: "function_call_output", call_id: "call_exec" });
    expect(body.input[2]).toEqual(raw.input[2]);
    expect(body.input[3]).toEqual(raw.input[3]);
  });

  test("restores non-streaming exec calls while leaving ordinary functions alone", () => {
    const upstream = JSON.stringify({
      id: "resp_1",
      output: [
        { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "{\"input\":\"const apps = await sky.list_apps();\"}", status: "completed" },
        { type: "function_call", id: "fc_other", call_id: "call_other", name: "ordinary", arguments: "{}", status: "completed" },
      ],
    });

    const restored = JSON.parse(restoreRoutedCustomCallsInJson(upstream, new Set(["exec"]))) as {
      output: Array<Record<string, unknown>>;
    };
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: "const apps = await sky.list_apps();",
    });
    expect(restored.output[0]).not.toHaveProperty("arguments");
    expect(restored.output[1]).toMatchObject({ type: "function_call", name: "ordinary", arguments: "{}" });
  });

  test("restores the streamed exec lifecycle and unwraps progressive input", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));
    expect(added).toHaveLength(1);
    expect(dataPayload(added[0]!).item).toMatchObject({
      type: "custom_tool_call",
      id: "ctc_exec",
      name: "exec",
      input: "",
    });

    expect(rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0, item_id: "fc_exec", delta: "{\"inp",
    }))).toEqual([]);
    const firstDelta = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0, item_id: "fc_exec", delta: "ut\":\"const apps = await sky.list_apps();\\n",
    }));
    expect(firstDelta).toHaveLength(1);
    expect(dataPayload(firstDelta[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.delta",
      item_id: "ctc_exec",
      delta: "const apps = await sky.list_apps();\n",
    });
    const secondDelta = rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0, item_id: "fc_exec", delta: "apps.length\"}",
    }));
    expect(dataPayload(secondDelta[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.delta",
      delta: "apps.length",
    });

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\\napps.length\"}",
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      item_id: "ctc_exec",
      input: "const apps = await sky.list_apps();\napps.length",
    });

    const itemDone = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_exec",
        call_id: "call_exec",
        name: "exec",
        arguments: "{\"input\":\"const apps = await sky.list_apps();\\napps.length\"}",
        status: "completed",
      },
    }));
    expect(dataPayload(itemDone[0]!).item).toMatchObject({
      type: "custom_tool_call",
      input: "const apps = await sky.list_apps();\napps.length",
    });

    const completed = rewrite(frame("response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_exec",
          call_id: "call_exec",
          name: "exec",
          arguments: "{\"input\":\"apps.length\"}",
          status: "completed",
        }],
      },
    }));
    const response = dataPayload(completed[0]!).response as { output: Array<Record<string, unknown>> };
    expect(response.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input: "apps.length" });
    rewrite.dispose?.();
  });

  test("buffers argument events until a missing added event is identified by item done", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);
    const deltaBlock = frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_exec",
      delta: "{\"input\":\"echo",
    });
    const argumentsDoneBlock = frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: "{\"input\":\"echo ok\"}",
    });

    expect(rewrite(deltaBlock)).toEqual([]);
    expect(rewrite(argumentsDoneBlock)).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const replayed = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_exec",
        call_id: "call_exec",
        name: "exec",
        arguments: "{\"input\":\"echo ok\"}",
        status: "completed",
      },
    }));
    expect(replayed.map(block => dataPayload(block).type)).toEqual([
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
    ]);
    expect(dataPayload(replayed[0]!)).toMatchObject({ item_id: "ctc_exec", delta: "echo" });
    expect(dataPayload(replayed[1]!)).toMatchObject({ item_id: "ctc_exec", input: "echo ok" });
    expect(dataPayload(replayed[2]!).item).toMatchObject({
      type: "custom_tool_call",
      id: "ctc_exec",
      name: "exec",
      input: "echo ok",
    });
    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
  });

  test("replays buffered events unchanged when item done identifies an ordinary function", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), budget);
    const deltaBlock = frame("response.function_call_arguments.delta", {
      output_index: 1,
      item_id: "fc_other",
      delta: "{}",
    });

    expect(rewrite(deltaBlock)).toEqual([]);
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);

    const replayed = rewrite(frame("response.output_item.done", {
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_other",
        call_id: "call_other",
        name: "ordinary",
        arguments: "{}",
        status: "completed",
      },
    }));
    expect(replayed).toEqual([deltaBlock, frame("response.output_item.done", {
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_other",
        call_id: "call_other",
        name: "ordinary",
        arguments: "{}",
        status: "completed",
      },
    })]);
    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
  });

  test("keeps progressive exec input consistent for escaped control characters", () => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]));
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec", arguments: "", status: "in_progress" },
    }));

    const fragments = ['{"inp', 'ut":"before\\', 'b\\fafter"}'];
    let streamedInput = "";
    for (const delta of fragments) {
      const blocks = rewrite(frame("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_exec",
        delta,
      }));
      for (const block of blocks) streamedInput += String(dataPayload(block).delta ?? "");
    }

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_exec",
      arguments: fragments.join(""),
    }));
    const doneInput = dataPayload(done[0]!).input;
    expect(streamedInput).toBe(doneInput);
    expect(streamedInput).toBe("before\b\fafter");
    rewrite.dispose?.();
  });

  test("handleResponses sends an upstream-safe exec function and restores client SSE", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\"}",
      status: "completed",
    };
    const upstream = [
      frame("response.output_item.added", { output_index: 0, item: { ...upstreamItem, arguments: "", status: "in_progress" } }),
      frame("response.function_call_arguments.done", { output_index: 0, item_id: "fc_exec", arguments: upstreamItem.arguments }),
      frame("response.output_item.done", { output_index: 0, item: upstreamItem }),
      frame("response.completed", { response: { id: "resp_1", status: "completed", output: [upstreamItem] } }),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
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

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "list apps" }] }],
          tools: [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }],
        }),
      }), config, { model: "", provider: "" });
      const clientSse = await response.text();
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundTools?.[0]).toMatchObject({ type: "function", name: "exec" });
      expect(clientSse).toContain('"type":"custom_tool_call"');
      expect(clientSse).toContain('"type":"response.custom_tool_call_input.done"');
      expect(clientSse).toContain('"input":"const apps = await sky.list_apps();"');
      expect(clientSse).not.toContain("response.function_call_arguments.done");
      expect(clientSse).not.toContain('"type":"function_call"');
      expect(clientSse).toContain("data: [DONE]");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses restores routed custom calls in non-streaming JSON", async () => {
    const savedFetch = globalThis.fetch;
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"const apps = await sky.list_apps();\"}",
      status: "completed",
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "resp_json",
      status: "completed",
      output: [upstreamItem],
    }), { headers: { "content-type": "application/json" } })) as typeof fetch;
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

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/deepseek-v4-flash",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "list apps" }] }],
          tools: [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }],
        }),
      }), config, { model: "", provider: "" });
      const body = await response.json() as { output: Array<Record<string, unknown>> };

      expect(body.output[0]).toMatchObject({
        type: "custom_tool_call",
        id: "ctc_exec",
        name: "exec",
        input: "const apps = await sky.list_apps();",
      });
      expect(body.output[0]).not.toHaveProperty("arguments");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses leaves custom tools native for forward-auth passthrough", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const upstreamItem = {
      type: "function_call",
      id: "fc_exec",
      call_id: "call_exec",
      name: "exec",
      arguments: "{\"input\":\"native\"}",
      status: "completed",
    };
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "resp_forward", status: "completed", output: [upstreamItem] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://forward.fixture.test",
          authMode: "forward",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({
          model: "fixture/native-model",
          stream: false,
          input: "run",
          tools: [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "grammar", syntax: "lark" } }],
        }),
      }), config, { model: "", provider: "" });
      const clientBody = await response.json() as { output: Array<Record<string, unknown>> };
      const outboundTools = outboundBody?.tools as Array<Record<string, unknown>> | undefined;

      expect(outboundTools?.[0]).toMatchObject({ type: "custom", name: "exec" });
      expect(clientBody.output[0]).toMatchObject({ type: "function_call", name: "exec" });
      expect(clientBody.output[0]).not.toHaveProperty("input");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
