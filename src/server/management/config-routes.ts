import { saveConfigPreservingClaudeCode } from "../../config";
import { VISION_REASONING_EFFORTS, isVisionReasoningEffort } from "../../reasoning-effort";
import { normalizeVisionReasoningForModel } from "../../vision/reasoning";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { handleConfigRoutes as handleBaseConfigRoutes } from "./config-routes-base";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sidecarResponseWithReasoning(
  response: Response,
  ctx: ManagementContext,
): Promise<Response> {
  if (!response.ok) return response;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response;
  }
  if (!isPlainRecord(body) || !isPlainRecord(body.vision)) return response;
  body.vision.reasoning = ctx.config.visionSidecar?.reasoning ?? "low";
  return jsonResponse(body, response.status, ctx.req, ctx.config);
}

/**
 * Maintainer wrapper for the current config routes.
 *
 * The base module is the byte-for-byte `dev` handler. This wrapper owns only the #1002 vision
 * reasoning extension so the takeover cannot overwrite newer config-route work while still making
 * the management boundary model-aware.
 */
export async function handleConfigRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (url.pathname !== "/api/sidecar-settings") {
    return handleBaseConfigRoutes(ctx);
  }

  if (req.method === "GET") {
    const response = await handleBaseConfigRoutes(ctx);
    return response ? sidecarResponseWithReasoning(response, ctx) : null;
  }

  if (req.method !== "PUT") return handleBaseConfigRoutes(ctx);

  let raw: unknown;
  try {
    raw = await req.clone().json();
  } catch {
    // Preserve the base handler's exact invalid-JSON/body-limit behavior.
    return handleBaseConfigRoutes(ctx);
  }

  const vision = isPlainRecord(raw) && isPlainRecord(raw.vision) ? raw.vision : undefined;
  const requestedReasoning = vision?.reasoning;
  if (requestedReasoning !== undefined && !isVisionReasoningEffort(requestedReasoning)) {
    return jsonResponse(
      { error: `vision.reasoning must be ${VISION_REASONING_EFFORTS.join(", ")}` },
      400,
      req,
      config,
    );
  }

  // Let the current `dev` handler validate and persist every pre-existing field first. No reasoning
  // mutation occurs if another field makes the request invalid.
  const response = await handleBaseConfigRoutes(ctx);
  if (!response || !response.ok) return response;

  if (vision && (requestedReasoning !== undefined || vision.model !== undefined)) {
    config.visionSidecar = { ...config.visionSidecar };
    const model = config.visionSidecar.model ?? "gpt-5.6-luna";
    const sourceReasoning = requestedReasoning ?? config.visionSidecar.reasoning;
    if (sourceReasoning !== undefined) {
      const normalized = normalizeVisionReasoningForModel(model, sourceReasoning);
      if (normalized !== undefined) config.visionSidecar.reasoning = normalized;
      else delete config.visionSidecar.reasoning;
      saveConfigPreservingClaudeCode(config);
    }
  }

  return sidecarResponseWithReasoning(response, ctx);
}
