import { describe, expect, test } from "bun:test";
import { normalizeCursorToolResultText } from "../src/adapters/cursor/tool-result-normalize";

describe("codex exec bridge empty-result normalization (devlog 260826 gap-7)", () => {
  test("empty exec cell output becomes explanatory text, not an error", () => {
    const out = normalizeCursorToolResultText("Script completed\nWall time 0.1 seconds\nOutput:\n", { toolName: "exec" });
    expect(out.changed).toBe(true);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("NOT lost context");
    expect(out.text).toContain("text(...)");
  });

  test("mcp display alias names route the same way", () => {
    const out = normalizeCursorToolResultText("", { toolName: "mcp_opencodex-responses_exec" });
    expect(out.changed).toBe(true);
    expect(out.text).toContain("empty output");
  });

  test("shell_command empty output routes too", () => {
    const out = normalizeCursorToolResultText("<empty>", { toolName: "shell_command" });
    expect(out.changed).toBe(true);
  });

  test("codex CLI native shell names route too (multi-round restart loop, QA round 2)", () => {
    for (const name of ["shell", "local_shell", "container.exec"]) {
      const out = normalizeCursorToolResultText("", { toolName: name });
      expect(out.changed).toBe(true);
      expect(out.isError).toBe(false);
    }
  });

  test("non-empty exec output passes through byte-identical", () => {
    const out = normalizeCursorToolResultText("Output:\nhello", { toolName: "exec" });
    expect(out.changed).toBe(false);
    expect(out.text).toBe("Output:\nhello");
  });

  test("computer-use empties keep the original error semantics", () => {
    const out = normalizeCursorToolResultText("", { toolName: "screenshot" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("get_app_state");
  });

  test("unrelated tools with empty output stay untouched", () => {
    const out = normalizeCursorToolResultText("", { toolName: "get_weather" });
    expect(out.changed).toBe(false);
  });
});
