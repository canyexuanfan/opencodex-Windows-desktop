/**
 * Stateless Responses wire repair for orphaned tool CALLS.
 *
 * DeepSeek's official Responses route is stateless and strict: a `function_call`,
 * `local_shell_call`, or `custom_tool_call` item with no matching output item in the same
 * body 400s with "No tool output found for tool call <call_id>". A Codex thread can reach
 * that state when an interrupted tool turn records the call but not its late-arriving
 * result. ocx already repaired orphaned OUTPUTS (output without call); these tests pin the
 * mirrored repair: synthesize an honest placeholder output right after the orphaned call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

const MODEL = "deepseek-v4-flash";

function deepseekProvider(): ReturnType<typeof providerConfigSeed> & { apiKey: string } {
  return { ...providerConfigSeed(getProviderRegistryEntry("deepseek")!), apiKey: "sk-test" };
}

describe("stateless Responses wire repairs orphaned tool calls", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function drive(input: unknown[]): Promise<{ url: string; body: Record<string, unknown> }> {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (inputUrl: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(inputUrl),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json({ id: "resp_deepseek", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    const config = { providers: { deepseek: deepseekProvider() } } as unknown as OcxConfig;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, input, stream: true }),
      }),
      config,
      { model: "", provider: "" },
    );
    return requests[0] ?? { url: "", body: {} };
  }

  test("synthesizes a function_call_output after a dangling function_call", async () => {
    const { url, body } = await drive([
      { type: "function_call", id: "fc_1", call_id: "call_dangling_fn", name: "write_stdin", arguments: "{}" },
    ]);
    expect(url).toBe("https://api.deepseek.com/responses");
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_dangling_fn", name: "write_stdin" });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_dangling_fn" });
    expect(String((input[1] as { output: unknown }).output)).toContain("no tool result was recorded");
    expect(input).toHaveLength(2);
  });

  test("synthesizes a function_call_output after a dangling local_shell_call", async () => {
    const { body } = await drive([
      { type: "local_shell_call", id: "sh_1", call_id: "call_dangling_sh", status: "completed", action: { type: "exec", command: ["echo", "ok"] } },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "local_shell_call", call_id: "call_dangling_sh" });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_dangling_sh" });
    expect(String((input[1] as { output: unknown }).output)).toContain("no tool result was recorded");
  });

  test("synthesizes a custom_tool_call_output after a dangling custom_tool_call", async () => {
    const { body } = await drive([
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_dangling_ct", name: "custom_probe", input: "{}" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "custom_tool_call", call_id: "call_dangling_ct" });
    expect(input[1]).toMatchObject({ type: "custom_tool_call_output", call_id: "call_dangling_ct" });
    expect(String((input[1] as { output: unknown }).output)).toContain("no tool result was recorded");
  });

  test("leaves intact call/output pairs untouched", async () => {
    const { body } = await drive([
      { type: "function_call", id: "fc_ok", call_id: "call_ok", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_ok", output: "ok" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_ok" });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_ok", output: "ok" });
    expect(JSON.stringify(body)).not.toContain("no tool result was recorded");
  });

  test("keeps converting orphan outputs to user messages (regression)", async () => {
    const { body } = await drive([
      { type: "function_call_output", call_id: "call_unknown", output: "orphan result" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "message", role: "user" });
    expect(JSON.stringify(input[0])).toContain("orphan result");
  });
});
