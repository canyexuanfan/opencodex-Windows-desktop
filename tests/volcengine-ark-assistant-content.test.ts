import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import type { OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

/**
 * #796: Volcengine Ark validates an assistant message's text as a REQUIRED parameter and treats
 * "" as absent, so any history containing a tool-call-only assistant 400s with
 * `MissingParameter: input.content.text`. Single-turn requests are fine; the failure needs the
 * tool-call turn.
 *
 * This cannot be fixed globally. xAI rejects the opposite way -- "Each message must have at least
 * one content element" -- and the existing "" is what satisfies it. So the two contracts conflict
 * and the fix is host-gated, which is exactly what these tests have to prove: every case runs the
 * SAME input through Ark and a generic host and asserts the two diverge.
 */

function providerFor(baseUrl: string): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, apiKey: "sk-test", authMode: "key" };
}

const ark = providerFor("https://ark.cn-beijing.volces.com/api/v3");
const generic = providerFor("https://example.test/v1");

interface ChatMsg {
  role: string;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function wire(provider: OcxProviderConfig, messages: OcxMessage[]): ChatMsg[] {
  const parsed: OcxParsedRequest = {
    modelId: "kimi-k3",
    context: { messages },
    stream: false,
    options: {},
  };
  const req = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
  return (JSON.parse(req.body) as { messages: ChatMsg[] }).messages;
}

function assistantToolCall(): OcxMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall" as const, id: "call_1", name: "shell", arguments: { cmd: "ls" } }],
    timestamp: 0,
  };
}

function assistantsOf(messages: ChatMsg[]): ChatMsg[] {
  return messages.filter(m => m.role === "assistant");
}

describe("Volcengine Ark empty assistant content (#796)", () => {
  const history: OcxMessage[] = [
    { role: "user", content: "list dir", timestamp: 0 },
    assistantToolCall(),
    { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "file1.txt", isError: false, timestamp: 0 },
  ];

  test("a tool-call-only assistant carries non-empty text for Ark", () => {
    const [assistant] = assistantsOf(wire(ark, history));
    expect(assistant.tool_calls).toHaveLength(1);
    // The exact reproduction from the issue. "" is what Ark rejects.
    expect(assistant.content).toBe(" ");
    expect(String(assistant.content).length).toBeGreaterThan(0);
  });

  test("the same history still uses \"\" for every other provider", () => {
    // The control. Without it the Ark assertion would also pass if the placeholder were applied
    // globally -- which would break xAI, whose validator requires the empty-string element.
    const [assistant] = assistantsOf(wire(generic, history));
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.content).toBe("");
  });

  test("a synthesized orphan tool-call assistant follows the same rule", () => {
    // A tool result with no matching call: the adapter fabricates the assistant turn, and that
    // fabricated message hits the same Ark validator.
    const orphan: OcxMessage[] = [
      { role: "user", content: "hi", timestamp: 0 },
      { role: "toolResult", toolCallId: "call_missing", toolName: "shell", content: "out", isError: false, timestamp: 0 },
    ];
    const arkOrphan = assistantsOf(wire(ark, orphan)).find(m => m.tool_calls?.length);
    const genericOrphan = assistantsOf(wire(generic, orphan)).find(m => m.tool_calls?.length);
    expect(arkOrphan?.content).toBe(" ");
    expect(genericOrphan?.content).toBe("");
  });

  test("the gate matches the host, not the path or a substring of it", () => {
    // A lookalike host must not inherit the quirk: the fix keys on an exact hostname set, so a
    // provider merely mentioning the string in its path stays on the default contract.
    const lookalike = providerFor("https://example.test/ark.cn-beijing.volces.com/v1");
    const [assistant] = assistantsOf(wire(lookalike, history));
    expect(assistant.content).toBe("");
  });

  test("Ark's regional sibling endpoint gets the same treatment", () => {
    const sea = providerFor("https://ark.ap-southeast.volces.com/api/v3");
    const [assistant] = assistantsOf(wire(sea, history));
    expect(assistant.content).toBe(" ");
  });
});
