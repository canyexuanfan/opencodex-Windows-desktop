import type { OcxConfig } from "../types";
import { jsonResponse } from "../server/auth-cors";
import { acquireTemporaryDrain, getActiveTurnCount } from "../server/lifecycle";
import {
  managementBodyTooLargeResponse,
  readManagementJsonBody,
  rethrowManagementBodyTooLarge,
} from "../server/management/body";
import { NativeProfileManager } from "./native-profile-manager";
import { NativeProfileError } from "./native-profile-types";
import { completeNativeMainRecovery } from "./native-profile-startup";
import { probeNativeProfileRecoveryState } from "./native-profile-store";

export interface NativeProfileApiDeps {
  manager?: NativeProfileManager;
  drainTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  probeRecoveryState?: typeof probeNativeProfileRecoveryState;
  completeRecovery?: typeof completeNativeMainRecovery;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await readManagementJsonBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
    return parsed as Record<string, unknown>;
  } catch (error) {
    rethrowManagementBodyTooLarge(error);
    throw new NativeProfileError("INVALID_REQUEST", "A JSON object body is required.", 400);
  }
}

async function withMainRequestDrain<T>(deps: NativeProfileApiDeps, operation: () => Promise<T>): Promise<T> {
  const drainLease = acquireTemporaryDrain("native-main-profile");
  if (!drainLease) throw new NativeProfileError("MAIN_REQUESTS_ACTIVE", "The proxy is already draining requests.", 503, true);
  try {
    const deadline = Date.now() + (deps.drainTimeoutMs ?? 10_000);
    while (getActiveTurnCount() > 0 && Date.now() < deadline) await (deps.sleep ?? Bun.sleep)(50);
    if (getActiveTurnCount() > 0) {
      throw new NativeProfileError("MAIN_REQUESTS_ACTIVE", "In-flight requests did not finish before the native-login switch deadline.", 409, true);
    }
    return await operation();
  } finally {
    drainLease.release();
  }
}

async function withRecoveryGateTransition<T>(
  manager: NativeProfileManager,
  deps: NativeProfileApiDeps,
  operation: () => Promise<T>,
  completeIfAlreadyClearAfterSuccess = false,
): Promise<T> {
  const context = manager.context;
  if (!context) return operation();
  const probe = deps.probeRecoveryState ?? probeNativeProfileRecoveryState;
  const before = probe(context);
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (before !== "none" || (completeIfAlreadyClearAfterSuccess && !operationFailed)) {
      try {
        const after = probe(context);
        if (after === "none") {
          (deps.completeRecovery ?? completeNativeMainRecovery)(context.homeId);
        }
      } catch (transitionError) {
        // Preserve the operation's typed/public error. A post-operation probe or
        // completion failure must not replace it; the gate remains fail closed.
        if (!operationFailed) throw transitionError;
      }
    }
  }
}

export async function handleNativeProfileAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
  deps: NativeProfileApiDeps = {},
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/native-main-profiles")) return null;
  try {
    const manager = deps.manager ?? new NativeProfileManager();
    if (url.pathname === "/api/native-main-profiles" && req.method === "GET") {
      return jsonResponse(await manager.list(), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/doctor" && req.method === "GET") {
      return jsonResponse(await manager.doctor(), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/register" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.label !== "string") throw new NativeProfileError("INVALID_REQUEST", "A profile label is required.", 400);
      return jsonResponse(await manager.register(input.label), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage" && req.method === "POST") {
      return jsonResponse(await manager.prepareStage(), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage/finish" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.stageId !== "string" || typeof input.label !== "string") {
        throw new NativeProfileError("INVALID_REQUEST", "A staging identifier and profile label are required.", 400);
      }
      return jsonResponse(await manager.finishStage(input.stageId, input.label), 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/stage/cancel" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.stageId !== "string") throw new NativeProfileError("INVALID_REQUEST", "A staging identifier is required.", 400);
      await manager.cancelStage(input.stageId);
      return jsonResponse({ ok: true }, 200, req, config);
    }
    if (url.pathname === "/api/native-main-profiles/switch" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.target !== "string") throw new NativeProfileError("INVALID_REQUEST", "A target profile is required.", 400);
      const switched = await withMainRequestDrain(deps, () => withRecoveryGateTransition(
        manager,
        deps,
        () => manager.switch(input.target as string, input.confirmedStopped === true),
      ));
      return jsonResponse(
        switched,
        200,
        req,
        config,
      );
    }
    if (url.pathname === "/api/native-main-profiles/recover" && req.method === "POST") {
      const input = await body(req);
      const recovered = await withMainRequestDrain(deps, () => withRecoveryGateTransition(
        manager,
        deps,
        () => manager.recover(input.rollback === true, input.confirmedStopped === true),
        true,
      ));
      return jsonResponse(recovered, 200, req, config);
    }
    return jsonResponse({ error: "Unknown native-profile operation", code: "INVALID_REQUEST" }, 404, req, config);
  } catch (error) {
    const tooLarge = managementBodyTooLargeResponse(error, req, config);
    if (tooLarge) return tooLarge;
    if (error instanceof NativeProfileError) {
      return jsonResponse({
        error: error.message,
        code: error.code,
        retryable: error.retryable,
        ...(error.cleanupRequired === true ? { cleanupRequired: true } : {}),
      }, error.status, req, config);
    }
    return jsonResponse({ error: "Native-profile operation failed.", code: "INTERNAL_ERROR" }, 500, req, config);
  }
}
