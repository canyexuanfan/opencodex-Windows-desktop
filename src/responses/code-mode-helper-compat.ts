import { normalizeApplyPatchDelimiters } from "./apply-patch-envelope";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unwrapPatchInput(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isPlainObject(parsed)) {
      if (typeof parsed.input === "string") return parsed.input;
      if (typeof parsed.patch === "string") return parsed.patch;
    }
  } catch {
    // Native custom calls carry the patch body directly.
  }
  return value;
}

/**
 * Convert a nested Code Mode helper call into unified-exec JavaScript.
 *
 * Parsed values are serialized as data, never interpolated as source, so command and patch text
 * cannot escape the generated call. Invalid structured shell payloads are also passed as data so
 * nested-tool validation can reject them without evaluating provider text as JavaScript.
 */
export function compileCodeModeHelperInput(argumentsText: unknown, toolName: string): string {
  if (typeof argumentsText !== "string") return "";
  if (toolName === "apply_patch") {
    const patch = normalizeApplyPatchDelimiters(unwrapPatchInput(argumentsText));
    return `const result = await tools.apply_patch(${JSON.stringify(patch)});\ntext(result);`;
  }
  let parsed: unknown = argumentsText;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    // Keep malformed provider text as data rather than executable source.
  }
  const args: unknown = isPlainObject(parsed) ? { ...parsed } : parsed;
  if (
    toolName === "shell_command"
    && isPlainObject(args)
    && typeof args.command === "string"
    && args.cmd === undefined
  ) {
    args.cmd = args.command;
    delete args.command;
  }
  return `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);`;
}
