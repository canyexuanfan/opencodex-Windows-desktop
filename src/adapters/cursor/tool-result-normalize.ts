/**
 * Cursor tool-result normalization for Computer Use / node_repl surfaces (#1920/#1866).
 *
 * Scoped re-implementation of PR #1920 per the 260818 campaign disposition
 * (REDESIGN-SMALL: "apply formatted.text at native toolResultPart + decode test").
 * Only empty-output and known-failure-state normalization ships here; screenshot
 * stripping and AXTree text compaction from the original PR are deliberately out
 * of scope (the native path already bounds step size by real serialized bytes,
 * dropping images oldest-first — see toolCallStep in protobuf-request.ts).
 */

const COMPUTER_USE_TOOL_NAMES = new Set([
  "node_repl",
  "node_repl__js",
  "mcp__node_repl__js",
  "get_app_state",
  "list_apps",
  "screenshot",
  "computer_use",
]);

function isNodeReplOrComputerUseTool(toolName?: string, toolNamespace?: string): boolean {
  if (toolNamespace && (toolNamespace === "mcp__node_repl" || toolNamespace.includes("node_repl") || toolNamespace.includes("computer_use"))) {
    return true;
  }
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  if (COMPUTER_USE_TOOL_NAMES.has(lower)) return true;
  return lower.startsWith("mcp__node_repl") || lower.startsWith("mcp__computer_use");
}

/**
 * Codex exec / shell-bridge tool names (flat and MCP-prefixed display aliases). An empty result
 * here is almost always a code-mode cell that never called text()/notify() — the cursor model
 * reads the blank [tool_result], concludes prior results were lost, and spirals into
 * re-orientation retries (devlog 260826_cursor_responses_gap, live subagent transcripts).
 */
function isCodexExecBridgeTool(toolName?: string, toolNamespace?: string): boolean {
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

/** Failure states the Computer Use / node_repl runtime reports as PLAIN TEXT inside a non-error result. */
const RUNTIME_FAILURE_GUIDANCE: ReadonlyArray<{ marker: string; guidance: string }> = [
  {
    marker: "SkyComputerUseError",
    guidance: "The Computer Use runtime rejected this action. Re-check application state with get_app_state before retrying.",
  },
  {
    marker: "sky is not defined",
    guidance: "The sky binding is unavailable in this context; Computer Use calls only work inside the privileged node_repl session.",
  },
  {
    marker: "has already been declared",
    guidance: "The node_repl session keeps earlier declarations; rename the variable or use var/reassignment instead of redeclaring.",
  },
  {
    marker: "unsupported import in exec",
    guidance: "Imports are not available in this exec context; use the injected globals instead.",
  },
];

/** Matches exec wrappers whose only payload is an empty-output marker. */
const EMPTY_EXEC_OUTPUT_REGEX = /^(?:(?:Script completed|Script failed|Command finished|Execution finished)[^\n]*\n+)?(?:Wall time[^\n]*\n+)?(?:Output:\s*)?(?:<empty>)?\s*$/;

export interface NormalizedToolResultText {
  text: string;
  isError: boolean;
  /** True when normalization changed either field (lets callers skip work on the common path). */
  changed: boolean;
}

/**
 * Normalize a Cursor-bound tool-result TEXT payload:
 *  - blank / empty-exec-wrapper output on Computer Use or node_repl tools becomes an
 *    actionable error instead of an empty string the model silently accepts;
 *  - known runtime failure states reported as plain text are marked isError with a
 *    one-line recovery hint appended.
 * Everything else passes through byte-identical.
 */
export function normalizeCursorToolResultText(
  text: string,
  options: { toolName?: string; toolNamespace?: string; isError?: boolean } = {},
): NormalizedToolResultText {
  const isError = options.isError === true;
  const computerUse = isNodeReplOrComputerUseTool(options.toolName, options.toolNamespace);
  if (computerUse && EMPTY_EXEC_OUTPUT_REGEX.test(text.trim())) {
    return {
      text: "[empty output: the tool ran but produced no stdout or return value. Verify application state with get_app_state, or make the script emit output.]",
      isError: true,
      changed: true,
    };
  }
  if (isCodexExecBridgeTool(options.toolName, options.toolNamespace) && EMPTY_EXEC_OUTPUT_REGEX.test(text.trim())) {
    return {
      text: "[empty output: the exec cell completed but emitted nothing. This is NOT lost context and NOT a blocked tool — in code mode call text(...) or notify(...) on any value you need to see (a bare await tools.exec_command(...) is not echoed automatically); in shell mode the command simply printed nothing. Do not re-run the same call expecting different output.]",
      isError: false,
      changed: true,
    };
  }
  if (!isError) {
    for (const { marker, guidance } of RUNTIME_FAILURE_GUIDANCE) {
      if (text.includes(marker)) {
        return { text: `${text}\n[recovery: ${guidance}]`, isError: true, changed: true };
      }
    }
  }
  return { text, isError, changed: false };
}
