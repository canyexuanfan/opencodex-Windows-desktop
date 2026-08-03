/**
 * Toggle routes for the integrations that are NOT file-merged clients.
 *
 * The six file clients live in `integration-routes.ts` and go through
 * `src/integrations/writer.ts`, which merges config fragments and journals every
 * write. These do not: Claude Code is a flag in our own config, and Grok owns a
 * fenced region of a file we do not otherwise write. Neither has a merged
 * fragment to own, so neither needs a snapshot, a journal row, or a restore
 * route — turning them back on is the undo.
 *
 * That conclusion cost eleven audit rounds; the reasoning is in
 * devlog/_plan/260803_integrations_toggle_all/, and 007 records why Codex and
 * Claude Desktop are NOT here: their state spans several artifacts and a live
 * database, so they need a durable operation record this module deliberately
 * does not have.
 *
 * Design of record: devlog/_plan/260803_integrations_toggle_all/030 (routes),
 * 011 (Claude Code), 012 (Grok).
 */
import { saveConfigPreservingClaudeCode } from "../../config";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";

export type NativeIntegrationClientId = "claude" | "grok";

/** Every reason this module can decline, in one place (audit r3 #6). */
export type NativeRefusalReason =
  | "not_installed"
  | "orphaned_marker"
  | "home_mismatch"
  | "config_busy"
  | "write_failed";

export interface NativeStatus {
  clientId: NativeIntegrationClientId;
  state: "absent" | "current" | "unsafe";
  installed: boolean;
  configPath: string;
  /**
   * Set when a disable would be refused right now. ADVISORY: the file can
   * change before the PUT, which re-checks and whose answer is authoritative.
   * It exists so the GUI does not offer an action we already know is blocked.
   */
  disableBlocked: { reason: NativeRefusalReason; message: string } | null;
}

export interface NativeStatusListEnvelope {
  clients: NativeStatus[];
}

export interface NativeToggleEnvelope {
  ok: true;
  clientId: NativeIntegrationClientId;
  changed: boolean;
  state: NativeStatus["state"];
  message: string;
  /** Present when the outcome needs more than success/failure to be honest. */
  reason?: string;
}

export interface NativeRefusalEnvelope {
  error: string;
  code: "native_integration_refused" | "native_integration_failed";
  clientId: NativeIntegrationClientId;
  reason: NativeRefusalReason;
  message: string;
}

function refusal(
  status: number,
  clientId: NativeIntegrationClientId,
  reason: NativeRefusalReason,
  message: string,
): Response {
  return jsonResponse({
    error: status >= 500 ? "native integration change failed" : "native integration change refused",
    code: status >= 500 ? "native_integration_failed" : "native_integration_refused",
    clientId, reason, message,
  } satisfies NativeRefusalEnvelope, status);
}

/** Absent means ON: the six read sites all treat only an explicit `false` as off. */
export function claudeCodeEnabled(config: ManagementContext["config"]): boolean {
  return config.claudeCode?.enabled !== false;
}

function claudeStatus(config: ManagementContext["config"], configPath: string): NativeStatus {
  return {
    clientId: "claude",
    state: claudeCodeEnabled(config) ? "current" : "absent",
    // The surface exists wherever the proxy does; there is no separate install.
    installed: true,
    configPath,
    // Nothing can refuse this disable: no external file, no shared teardown.
    disableBlocked: null,
  };
}

/**
 * Genuine lock contention, as opposed to a lock we could not open at all.
 *
 * `ConfigMutationLockError` carries a constant `code` and wraps EVERY
 * acquisition failure — an unopenable database, an ACL that would not set, as
 * well as a real conflict. Only the cause distinguishes them, and mapping the
 * whole class to a retryable 409 would tell the user to retry a lock file they
 * cannot open, which fails identically forever (audit r8 #2).
 */
function isLockContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause?.code === "SQLITE_BUSY";
}

function isConfigLockError(error: unknown): boolean {
  return !!error && typeof error === "object"
    && (error as { code?: unknown }).code === "CONFIG_MUTATION_LOCK_UNAVAILABLE";
}

export async function handleNativeIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;

  if (url.pathname === "/api/native-integrations" && req.method === "GET") {
    const { getConfigPath } = await import("../../config");
    return jsonResponse({
      clients: [claudeStatus(config, getConfigPath())],
    } satisfies NativeStatusListEnvelope);
  }

  if (url.pathname === "/api/native-integrations/claude" && req.method === "PUT") {
    let body: { enabled?: unknown };
    try {
      body = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }

    const enabled = body.enabled;
    if (claudeCodeEnabled(config) === enabled) {
      return jsonResponse({
        ok: true, clientId: "claude", changed: false,
        state: enabled ? "current" : "absent",
        message: enabled ? "Claude inbound is already on" : "Claude inbound is already off",
      } satisfies NativeToggleEnvelope);
    }

    const next = { ...(config.claudeCode ?? {}), enabled };
    /*
     * Stamp the migration sentinel on every persist of this block, exactly as
     * PUT /api/claude-code does (agent-settings-routes.ts:1068).
     *
     * The migration reads "a claudeCode block with no authMode" as a pre-upgrade
     * subscriber and pins it to literal subscription. Toggling Claude ON is one
     * of the two ways a block gets CREATED, so without this the next startServer
     * would silently convert a user's Auto auth mode into a sticky manual
     * subscription — a failure that surfaces nowhere near this route.
     */
    if (!next.authModeMigratedAt) next.authModeMigratedAt = new Date().toISOString();
    config.claudeCode = next;

    /*
     * `deps.` first: ManagementApiDeps carries this seam so route tests with an
     * in-memory fixture cannot overwrite the developer's real OPENCODEX_HOME.
     */
    const persist = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;
    try {
      persist(config);
    } catch (error) {
      if (isConfigLockError(error)) {
        return isLockContention(error)
          ? refusal(409, "claude", "config_busy",
              "Another process is saving the configuration right now. Try again in a moment.")
          : refusal(500, "claude", "write_failed",
              `The configuration lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }

    return jsonResponse({
      ok: true, clientId: "claude", changed: true,
      state: enabled ? "current" : "absent",
      message: enabled ? "Claude inbound enabled" : "Claude inbound disabled",
    } satisfies NativeToggleEnvelope);
  }

  return null;
}
