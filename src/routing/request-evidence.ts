/**
 * Cheap request-side evidence extraction for policy routing (RI-05).
 *
 * Extracts only what the request body can prove: whether the caller asked for
 * tools and whether the input contains image parts. Context-window size is
 * left unknown at routing time (documented limitation) - the dry-run API/CLI
 * remains the evidence-inspection surface for context-sensitive profiles.
 */

import type { PolicyRequestEvidence } from "./evaluator";

function partContainsImage(part: unknown): boolean {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  const record = part as Record<string, unknown>;
  if (record.type === "image" || record.type === "input_image") return true;
  if (record.image_url !== undefined || record.image !== undefined) return true;
  // Responses/Chat/Claude nest image parts under message `content` arrays
  // (e.g. `{ type: "message", content: [{ type: "input_image", ... }] }`);
  // walk nested arrays so vision requests are not missed.
  if (Array.isArray(record.content)) return record.content.some(partContainsImage);
  return false;
}

function inputContainsImage(input: unknown): boolean {
  if (typeof input === "string") return false;
  if (!Array.isArray(input)) return false;
  return input.some(partContainsImage);
}

export function evidenceFromBody(body: unknown): PolicyRequestEvidence {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const tools = Array.isArray(record.tools) && record.tools.length > 0;
  // `input` (Responses) or `messages` (Chat/Claude) both carry image parts.
  const image = inputContainsImage(record.input) || inputContainsImage(record.messages);
  return {
    ...(tools ? { toolsRequired: true } : {}),
    ...(image ? { imageInputRequired: true } : {}),
  };
}
