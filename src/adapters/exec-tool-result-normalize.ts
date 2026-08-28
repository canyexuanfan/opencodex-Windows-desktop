/**
 * Provider-neutral empty-exec-output normalization.
 *
 * A code-mode `exec` cell that never calls `text()`/`notify()` returns nothing: the last
 * expression value is NOT echoed automatically. The routed model reads a blank tool result,
 * concludes its earlier output was lost, and burns turns re-running the same call or restarting
 * the task from scratch. Naming that state explicitly is what breaks the loop.
 *
 * This module owns the shared detection so every adapter reports the same thing. Cursor keeps its
 * own wrapper (`normalizeCursorToolResultText`) for Computer Use precedence and isError policy;
 * Kiro consumes this helper directly.
 */

/** Matches exec wrappers whose only payload is an empty-output marker. */
export const EMPTY_EXEC_OUTPUT_REGEX = /^(?:(?:Script completed|Script failed|Command finished|Execution finished)[^\n]*\n+)?(?:Wall time[^\n]*\n+)?(?:Output:\s*)?(?:<empty>)?\s*$/;

/**
 * The guidance itself. Worded to close all three wrong conclusions a model draws from a blank
 * result: that context was lost, that the tool is blocked, and that retrying will differ.
 */
export const EMPTY_EXEC_OUTPUT_MESSAGE =
  "[empty output: the exec cell completed but emitted nothing. This is NOT lost context and NOT a blocked tool — in code mode call text(...) or notify(...) on any value you need to see (a bare await tools.exec_command(...) is not echoed automatically); in shell mode the command simply printed nothing. Do not re-run the same call expecting different output.]";

/**
 * Codex exec / shell-bridge tool names (flat and MCP-prefixed display aliases). An empty result
 * here is almost always a code-mode cell that never called text()/notify().
 */
export function isCodexExecBridgeTool(toolName?: string, toolNamespace?: string): boolean {
  if (toolNamespace && toolNamespace.includes("opencodex-responses")) return true;
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return (
    lower === "exec"
    || lower === "exec_command"
    || lower === "shell_command"
    // Codex CLI/desktop native tool names: the multi-round "이전 출력이 비어 있어 처음부터"
    // restart loop reproduced via codex exec because `shell` was not in this set
    // (devlog 260826 gap-8 QA round 2).
    || lower === "shell"
    || lower === "local_shell"
    || lower === "container.exec"
    || lower.startsWith("mcp_opencodex-responses_")
    || lower.startsWith("mcp__opencodex-responses__")
  );
}

/** True when this result is an exec-bridge call that produced no usable output. */
export function isEmptyExecToolResult(
  text: string,
  options: { toolName?: string; toolNamespace?: string } = {},
): boolean {
  return isCodexExecBridgeTool(options.toolName, options.toolNamespace)
    && EMPTY_EXEC_OUTPUT_REGEX.test(text.trim());
}

/**
 * Returns the guidance text when this is an empty exec-bridge result, else `undefined` so the
 * caller keeps its own fallback. Undefined rather than the original text: an adapter must be able
 * to tell "not my case" from "normalized to the same string".
 */
export function normalizeEmptyExecToolResultText(
  text: string,
  options: { toolName?: string; toolNamespace?: string } = {},
): string | undefined {
  return isEmptyExecToolResult(text, options) ? EMPTY_EXEC_OUTPUT_MESSAGE : undefined;
}
