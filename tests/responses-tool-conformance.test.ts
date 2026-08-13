import { describe, expect, it } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";
import { jsonToolItems, streamedEventNames, streamedToolItems } from "./helpers/responses-conformance";

/**
 * Responses tool round-trip conformance
 * (devlog/_plan/260813_routed_tool_discovery_profiles/030-034).
 *
 * The plan's premise was that a translator reading only top-level `tools` can silently erase
 * terminal, custom and namespace tools, and that the model then emits ordinary text and
 * completes normally — a failure that looks like model behavior rather than protocol loss.
 * This suite pins where that risk actually lives in THIS codebase, which is not where the
 * plan assumed: `additional_tools` is handled, so the residual exposure is malformed input,
 * unknown tool kinds, and stream/non-stream divergence.
 *
 * Several cases below deliberately pin CURRENT degradation rather than desired behavior.
 * They are labeled as such, so a future change to that behavior fails here loudly instead of
 * being discovered by a user whose tool vanished.
 */

const MODEL = "deepseek/glm-5.2";

function request(input: unknown[], tools?: unknown[]): Record<string, unknown> {
  return {
    model: MODEL,
    input,
    ...(tools ? { tools } : {}),
  };
}

function toolNames(parsed: ReturnType<typeof parseRequest>): string[] {
  return (parsed.context.tools ?? []).map(tool => tool.name);
}

describe("Responses Lite additional_tools declaration merge", () => {
  const fnTool = { type: "function", name: "read_file", parameters: { type: "object", properties: {} } };
  const nsTool = {
    type: "namespace",
    name: "github",
    tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
  };
  const customTool = { type: "custom", name: "apply_patch" };

  it("merges top-level tools and additional_tools input items", () => {
    const parsed = parseRequest(request(
      [{ type: "additional_tools", role: "developer", tools: [customTool] }],
      [fnTool],
    ));
    expect(toolNames(parsed)).toEqual(["read_file", "apply_patch"]);
  });

  it("accepts an additional_tools-only request, the Codex Desktop responses_lite shape", () => {
    // The tool surface rides INSIDE input rather than body.tools. A translator that reads
    // only body.tools sees an empty catalog and the turn silently loses every tool.
    const parsed = parseRequest(request(
      [{ type: "additional_tools", role: "developer", tools: [fnTool, nsTool, customTool] }],
    ));
    // Namespaced children keep their BARE name; the namespace rides alongside on the tool.
    expect(toolNames(parsed)).toEqual(["read_file", "search", "apply_patch"]);
    expect(parsed.context.tools?.find(tool => tool.name === "search")?.namespace).toBe("github");
  });

  it("preserves wire order across multiple additional_tools groups", () => {
    const parsed = parseRequest(request([
      { type: "additional_tools", role: "developer", tools: [fnTool] },
      { type: "additional_tools", role: "developer", tools: [customTool] },
    ]));
    expect(toolNames(parsed)).toEqual(["read_file", "apply_patch"]);
  });

  it("lets the top-level declaration win a qualified-name collision", () => {
    const shadowed = { type: "function", name: "read_file", parameters: { type: "object", properties: { shadow: { type: "string" } } } };
    const parsed = parseRequest(request(
      [{ type: "additional_tools", role: "developer", tools: [shadowed] }],
      [fnTool],
    ));
    expect(toolNames(parsed)).toEqual(["read_file"]);
    // The surviving entry is the TOP-LEVEL one, not the nested shadow.
    expect(parsed.context.tools?.[0]?.parameters).toEqual(fnTool.parameters as never);
  });

  it("CURRENT BEHAVIOR: a malformed additional_tools item is ignored, not rejected", () => {
    // devlog 031 asks for explicit failure here. Today the item is skipped silently, so a
    // typo in the tool surface degrades to "model has no tools" with no diagnostic. Pinned
    // so that changing it to a hard error is a visible, deliberate decision.
    const parsed = parseRequest(request([
      { type: "additional_tools", role: "developer", tools: "not-an-array" },
    ]));
    expect(parsed.context.tools ?? []).toEqual([]);
  });
});

describe("Responses tool-kind discrimination", () => {
  it("maps each known kind onto its internal marker", () => {
    const parsed = parseRequest(request([], [
      { type: "function", name: "fn", parameters: { type: "object", properties: {} } },
      { type: "custom", name: "freeform" },
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
      { type: "namespace", name: "ns", tools: [{ type: "function", name: "child", parameters: { type: "object", properties: {} } }] },
    ]));
    const byName = new Map((parsed.context.tools ?? []).map(tool => [tool.name, tool]));
    expect(byName.get("fn")?.freeform).toBeUndefined();
    expect(byName.get("freeform")?.freeform).toBe(true);
    expect(byName.get("tool_search")?.toolSearch).toBe(true);
    expect(byName.get("child")?.namespace).toBe("ns");
  });

  it("CURRENT BEHAVIOR: an unknown NAMED kind survives as a callable function", () => {
    // Better than the historical silent drop, but the original kind is not recoverable, so
    // the response cannot be restored as that kind either.
    const parsed = parseRequest(request([], [
      { type: "computer_use_preview", name: "computer", parameters: { type: "object", properties: {} } },
    ]));
    expect(toolNames(parsed)).toEqual(["computer"]);
    expect(parsed.context.tools?.[0]?.freeform).toBeUndefined();
  });

  it("CURRENT BEHAVIOR: an unknown UNNAMED kind disappears entirely", () => {
    // This is the plan's silent-loss class, still live. There is no name to pass through, so
    // the declaration is dropped with no diagnostic.
    const parsed = parseRequest(request([], [
      { type: "some_future_hosted_tool", config: { enabled: true } },
    ]));
    expect(parsed.context.tools ?? []).toEqual([]);
  });

  it("CURRENT BEHAVIOR: a non-function child inside a namespace disappears", () => {
    const parsed = parseRequest(request([], [
      {
        type: "namespace",
        name: "ns",
        tools: [
          { type: "function", name: "kept", parameters: { type: "object", properties: {} } },
          { type: "custom", name: "dropped" },
        ],
      },
    ]));
    expect(toolNames(parsed)).toEqual(["kept"]);
  });
});

describe("tool_search call and output history", () => {
  it("loads definitions returned by a tool_search_output into the active catalog", () => {
    const parsed = parseRequest(request([
      { type: "message", role: "user", content: [{ type: "input_text", text: "find it" }] },
      { type: "tool_search_call", id: "ts_1", call_id: "ts_1", execution: "client", arguments: "{\"query\":\"repl\"}", status: "completed" },
      {
        type: "tool_search_output",
        call_id: "ts_1",
        status: "completed",
        execution: "client",
        tools: [{ type: "function", name: "node_repl", parameters: { type: "object", properties: {} } }],
      },
    ], [
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
    ]));

    // The discovered tool must be callable on the NEXT turn, or deferred discovery is a
    // one-way trip and the model can never invoke what it just found.
    expect(toolNames(parsed)).toContain("node_repl");
    const loaded = parsed.context.tools?.find(tool => tool.name === "node_repl");
    expect(loaded?.loadedFromToolSearch).toBe(true);
  });

  it("flattens a namespaced tool discovered through tool_search", () => {
    const parsed = parseRequest(request([
      {
        type: "tool_search_output",
        call_id: "ts_2",
        status: "completed",
        execution: "client",
        tools: [{
          type: "namespace",
          name: "browser",
          tools: [{ type: "function", name: "open", parameters: { type: "object", properties: {} } }],
        }],
      },
    ], [
      { type: "tool_search", execution: "client", description: "search", parameters: { type: "object", properties: {} } },
    ]));
    expect(toolNames(parsed)).toContain("open");
    expect(parsed.context.tools?.find(tool => tool.name === "open")?.namespace).toBe("browser");
  });
});

describe("streaming and non-streaming tool parity", () => {
  const nsMap = new Map([["ns__child", { namespace: "ns", name: "child" }]]);
  const freeform = new Set(["apply_patch"]);
  const toolSearch = new Set(["tool_search"]);

  const cases: Array<{ label: string; events: AdapterEvent[] }> = [
    {
      label: "function call",
      events: [
        { type: "tool_call_start", id: "call_fn", name: "read_file" },
        { type: "tool_call_delta", arguments: "{\"path\"" },
        { type: "tool_call_delta", arguments: ":\"a.txt\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "custom/freeform call with split escapes and non-ASCII",
      events: [
        { type: "tool_call_start", id: "call_custom", name: "apply_patch" },
        { type: "tool_call_delta", arguments: "{\"input\":\"안녕 \\" },
        { type: "tool_call_delta", arguments: "\"quoted\\\" 世界\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "namespaced call",
      events: [
        { type: "tool_call_start", id: "call_ns", name: "ns__child" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "tool_search call",
      events: [
        { type: "tool_call_start", id: "call_ts", name: "tool_search" },
        { type: "tool_call_delta", arguments: "{\"query\":\"repl\"}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
    {
      label: "text before a call",
      events: [
        { type: "text_delta", text: "working" },
        { type: "tool_call_start", id: "call_after_text", name: "read_file" },
        { type: "tool_call_delta", arguments: "{}" },
        { type: "tool_call_end" },
        { type: "done" },
      ],
    },
  ];

  for (const { label, events } of cases) {
    it(`agrees between transports for a ${label}`, async () => {
      const streamed = await streamedToolItems(events, MODEL, nsMap, freeform, toolSearch);
      const json = jsonToolItems(events, MODEL, { toolNsMap: nsMap, freeformToolNames: freeform, toolSearchToolNames: toolSearch });
      // Same restored item TYPE, name, call id and payload on both transports. A divergence
      // here is the "restored as the wrong event" failure class from devlog 034.
      expect(streamed).toEqual(json);
    });
  }

  it("restores each kind as its own item type rather than collapsing to function_call", async () => {
    const kinds = await Promise.all(cases.map(async ({ events }) => {
      const [item] = await streamedToolItems(events, MODEL, nsMap, freeform, toolSearch);
      return item?.type;
    }));
    expect(kinds).toEqual([
      "function_call",
      "custom_tool_call",
      "function_call",
      "tool_search_call",
      "function_call",
    ]);
  });

  it("emits custom input deltas on the streamed path only", async () => {
    const custom = cases.find(entry => entry.label.startsWith("custom"))!;
    const names = await streamedEventNames(custom.events, MODEL, nsMap, freeform, toolSearch);
    expect(names).toContain("response.custom_tool_call_input.delta");
    expect(names).not.toContain("response.function_call_arguments.delta");
  });
});

describe("parallel tool-call capability", () => {
  it("CURRENT LIMITATION: interleaved calls cannot be represented by AdapterEvent", async () => {
    // `tool_call_start` carries an id, but `tool_call_delta` and `tool_call_end` do not
    // (src/types.ts). The bridge therefore tracks ONE call at a time, so a provider that
    // interleaves two calls has no way to say which fragment belongs to which.
    //
    // This test pins the consequence rather than pretending it works: the second start
    // closes the first call, and the interleaved fragments are NOT reunited with their
    // owners. Fixing the event contract should make this assertion fail.
    const interleaved: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_a", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"a" },
      { type: "tool_call_start", id: "call_b", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"b.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];

    const streamed = await streamedToolItems(interleaved, MODEL);
    const json = jsonToolItems(interleaved, MODEL);
    // Both transports agree with each other, which is what makes this a contract limitation
    // rather than a transport bug.
    expect(streamed).toEqual(json);

    const payloads = streamed.map(item => item.payload);
    // call_a's fragment did not receive call_b's continuation: the arguments are split by
    // ARRIVAL ORDER, not by call id.
    expect(payloads[0]).toBe("{\"path\":\"a");
    expect(streamed.map(item => item.call_id)).toEqual(["call_a", "call_b"]);
  });
});
