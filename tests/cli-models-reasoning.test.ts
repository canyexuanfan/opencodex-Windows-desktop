import { describe, expect, test } from "bun:test";
import { parseReasoningArgs } from "../src/cli/models";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";

/**
 * The API validates reasoning ladders (9 tests in catalog-input-modality-enum.test.ts),
 * but the CLI paths carry their own parsing and validation copies: `ocx models add`
 * validates offline before writing config.json, and `ocx models edit` maps flags onto
 * the PUT body ("-" -> null). These tests pin that mapping so CLI and API cannot drift.
 */
describe("ocx models add --reasoning-efforts parsing", () => {
  test("a valid ladder is canonicalized into Codex order and deduped", () => {
    expect(parseReasoningArgs("max,low,high,low", undefined)).toEqual({
      reasoningEfforts: ["low", "high", "max"],
    });
  });

  test("an unknown effort is rejected and names the offending value", () => {
    const parsed = parseReasoningArgs("low,deep", undefined);
    expect(parsed.error).toContain("deep");
    expect(parsed.reasoningEfforts).toBeUndefined();
  });

  test("an empty string is rejected instead of silently meaning something", () => {
    expect(parseReasoningArgs("", undefined)?.error).toContain("comma-separated");
    expect(parseReasoningArgs("low,,high", undefined)?.error).toContain("comma-separated");
  });

  test('"-" omits the field (inherit) exactly like the API null-clear', () => {
    expect(parseReasoningArgs("-", undefined)).toEqual({});
    expect(parseReasoningArgs(undefined, "-")).toEqual({});
  });

  test("a default must be a ladder member", () => {
    const parsed = parseReasoningArgs("low,high", "max");
    expect(parsed.error).toContain("max");
    expect(parsed.error).toContain("not in the declared reasoning efforts");
  });

  test("a default requires a ladder", () => {
    expect(parseReasoningArgs(undefined, "high")?.error).toContain("requires --reasoning-efforts");
  });

  test("a member default is accepted", () => {
    expect(parseReasoningArgs("low,high", "high")).toEqual({
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    });
  });
});

describe("ocx models edit reasoning flag mapping onto the PUT body", () => {
  async function editWith(patchArgs: string[]): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "cm-1", ...capturedBody }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const code = await handleModelsRuntimeCommand("edit", ["cm-1", ...patchArgs], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });
    expect(code).toBe(0);
    return capturedBody ?? {};
  }

  test('"--reasoning-efforts -" maps to null (restore inheritance)', async () => {
    const body = await editWith(["--reasoning-efforts", "-"]);
    expect(body.reasoningEfforts).toBeNull();
  });

  test("a csv ladder maps to an array", async () => {
    const body = await editWith(["--reasoning-efforts", "low,high"]);
    expect(body.reasoningEfforts).toEqual(["low", "high"]);
  });

  test('"--default-reasoning-effort -" maps to null', async () => {
    const body = await editWith(["--default-reasoning-effort", "-"]);
    expect(body.defaultReasoningEffort).toBeNull();
  });

  test("a member default maps to its string", async () => {
    const body = await editWith(["--reasoning-efforts", "low,high", "--default-reasoning-effort", "high"]);
    expect(body.reasoningEfforts).toEqual(["low", "high"]);
    expect(body.defaultReasoningEffort).toBe("high");
  });
});
