import type { OcxParsedRequest } from "../types";
import { namespacedToolName } from "../types";

const MAX_KIRO_TOOL_DESCRIPTION = 1024;

function sanitizeKiroSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeKiroSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = sanitizeKiroSchema(child);
  }
  return out;
}

function ensureRootObjectType(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {};
  // Bedrock rejects oneOf/allOf/anyOf at the root ("input_schema does not support oneOf, allOf, or
  // anyOf at the top level"). Flatten them into a single object schema by merging every variant's
  // properties so the model can still supply any valid argument. Required is merged only for allOf
  // (AND semantics); anyOf/oneOf (OR) leave required off so a valid single-branch call passes.
  const composition = obj.oneOf ?? obj.anyOf ?? obj.allOf;
  if (Array.isArray(composition)) {
    const merged: Record<string, unknown> = { type: "object" };
    const props: Record<string, unknown> = {};
    const required = new Set<string>();
    for (const variant of composition) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as Record<string, unknown>;
      if (v.properties && typeof v.properties === "object") {
        Object.assign(props, sanitizeKiroSchema(v.properties) as Record<string, unknown>);
      }
      if (obj.allOf !== undefined && Array.isArray(v.required)) {
        for (const r of v.required) if (typeof r === "string") required.add(r);
      }
    }
    if (Object.keys(props).length > 0) merged.properties = props;
    if (required.size > 0) merged.required = [...required];
    return merged;
  }
  const t = obj.type;
  if (t === "object") return obj;
  if (Array.isArray(t) && t.includes("object")) return { ...obj, type: "object" };
  return { ...obj, type: "object" };
}

export function convertKiroToolContext(parsed: OcxParsedRequest): { tools: unknown[]; systemAdditions: string[] } {
  const tools = parsed.context.tools ?? [];
  const systemAdditions: string[] = [];
  return {
    tools: tools.map(t => {
      const description = t.description || `Tool: ${t.name}`;
      // Send the full namespaced wire name (e.g. mcp__chrome-devtools__navigate_page) so Kiro echoes
      // it back unchanged; the bridge's toolNsMap is keyed by this name and restores the MCP namespace
      // Codex routes by. Truncating here breaks long MCP/computer-use round trips.
      const toolName = namespacedToolName(t.namespace, t.name);
      const kiroDescription = description.length > MAX_KIRO_TOOL_DESCRIPTION
        ? `Tool documentation moved to the system prompt: ${toolName}.`
        : description;
      if (description.length > MAX_KIRO_TOOL_DESCRIPTION) {
        systemAdditions.push([`### Tool documentation: ${toolName}`, description].join("\n"));
      }
      return {
        toolSpecification: {
          name: toolName,
          description: kiroDescription,
          inputSchema: { json: ensureRootObjectType(sanitizeKiroSchema(t.parameters ?? {})) },
        },
      };
    }),
    systemAdditions,
  };
}

export function convertKiroTools(parsed: OcxParsedRequest): unknown[] {
  return convertKiroToolContext(parsed).tools;
}
