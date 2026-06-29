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
  // anyOf at the top level") and requires the root type to be "object". Flatten every root
  // composition into the object schema while preserving the root's own properties/required and any
  // other sibling keys. allOf merges required (AND); anyOf/oneOf drop required so a single valid
  // branch still passes. Nested (non-root) composition is left intact — only the root is illegal.
  const COMPOSITION_KEYS = ["oneOf", "anyOf", "allOf"] as const;
  const hasComposition = COMPOSITION_KEYS.some(k => Array.isArray(obj[k]));
  const t = obj.type;
  const rootObjectType = t === "object" || (Array.isArray(t) && t.includes("object"));
  if (!hasComposition) {
    if (rootObjectType && t === "object") return obj;
    return { ...obj, type: "object" };
  }

  const props: Record<string, unknown> = {};
  const required = new Set<string>();
  // Seed with the root's own properties/required so a schema like
  // { type:"object", properties:{path}, required:["path"], oneOf:[...] } keeps them.
  if (obj.properties && typeof obj.properties === "object") {
    Object.assign(props, sanitizeKiroSchema(obj.properties) as Record<string, unknown>);
  }
  if (Array.isArray(obj.required)) {
    for (const r of obj.required) if (typeof r === "string") required.add(r);
  }
  for (const key of COMPOSITION_KEYS) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    // allOf is conjunction: its required fields always apply. oneOf/anyOf are disjunction, so
    // promoting their required would over-constrain a valid single-branch call.
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as Record<string, unknown>;
      if (v.properties && typeof v.properties === "object") {
        Object.assign(props, sanitizeKiroSchema(v.properties) as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(v.required)) {
        for (const r of v.required) if (typeof r === "string") required.add(r);
      }
    }
  }

  // Keep all non-composition sibling keys (description, $defs, definitions, etc.); replace
  // type/properties/required with the flattened object form.
  const merged: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "type" || key === "properties" || key === "required") continue;
    merged[key] = child;
  }
  merged.type = "object";
  if (Object.keys(props).length > 0) merged.properties = props;
  if (required.size > 0) merged.required = [...required];
  return merged;
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
