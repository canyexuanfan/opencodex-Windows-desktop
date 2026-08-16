import { expect, test } from "bun:test";
import { createOpenAIChatAdapter as createOpenAIChatAdapterProduction } from "../src/adapters/openai-chat";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createOpenAIChatAdapter = (...args: Parameters<typeof createOpenAIChatAdapterProduction>) =>
  withTestTranslatorBudget(createOpenAIChatAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  authMode: "key",
};

async function collect(stream: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("object-valued streamed function.name is a 502 with value-free compatibility detail", async () => {
  const privateNameValue = "must-not-reach-diagnostics";
  const privateArguments = "must-not-reach-diagnostics-either";
  const adapter = createOpenAIChatAdapter(provider);
  const response = new Response(
    `data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: {
              name: { privateNameValue },
              arguments: JSON.stringify({ value: privateArguments }),
            },
          }],
        },
      }],
    })}\n\n`,
  );

  const events = await collect(adapter.parseStream(response));

  expect(events).toEqual([{
    type: "error",
    status: 502,
    errorType: "upstream_error",
    message: "upstream response contained invalid tool calls (tool_call_function_name_invalid; callIndex=0; valueType=object)",
  }]);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(privateNameValue);
  expect(serialized).not.toContain(privateArguments);
  expect(serialized).not.toContain("call_1");
});
