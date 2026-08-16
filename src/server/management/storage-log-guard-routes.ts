import { resolveCodexHomeDir } from "../../codex/home";
import { inspectCodexLogs, type CodexLogGuardInspection } from "../../codex/log-guard/inspect";
import { scanStorage } from "../../storage/scanner";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

const INSPECTION_FAILED_MESSAGE = "Codex log inspection failed";

function inspectionUnavailable(report: CodexLogGuardInspection): boolean {
  return report.schema.state === "unavailable";
}

/** Read-only Codex Log Guard management surface. Mutation endpoints arrive in PR 2/3. */
export async function handleStorageLogGuardRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  if (req.method !== "GET") return null;

  if (url.pathname === "/api/storage/codex-logs") {
    try {
      const report = inspectCodexLogs();
      if (inspectionUnavailable(report)) {
        return jsonResponse({ error: "inspect_failed", message: INSPECTION_FAILED_MESSAGE }, 500, req, config);
      }
      return jsonResponse(report, 200, req, config);
    } catch {
      return jsonResponse({
        error: "inspect_failed",
        message: INSPECTION_FAILED_MESSAGE,
      }, 500, req, config);
    }
  }

  if (url.pathname !== "/api/storage") return null;

  // Keep the existing CODEX_HOME scan as the primary storage contract. The Log Guard
  // report is attached separately so an external sqlite_home is visible without being
  // silently folded into CODEX_HOME totals.
  let storage;
  try {
    storage = scanStorage();
  } catch {
    const fallback = {
      codexHome: resolveCodexHomeDir(),
      generatedAt: Date.now(),
      total: { bytes: 0, fileCount: 0 },
      buckets: [],
      error: "scan_failed",
    };
    try {
      const report = inspectCodexLogs();
      return inspectionUnavailable(report)
        ? jsonResponse({ ...fallback, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config)
        : jsonResponse({ ...fallback, codexLogs: report }, 200, req, config);
    } catch {
      return jsonResponse({ ...fallback, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config);
    }
  }

  try {
    const report = inspectCodexLogs();
    return inspectionUnavailable(report)
      ? jsonResponse({ ...storage, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config)
      : jsonResponse({ ...storage, codexLogs: report }, 200, req, config);
  } catch {
    // Log Guard inspection is auxiliary to the existing Storage page. A config/path
    // resolution failure must not take the legacy read-only storage report down with it.
    return jsonResponse({ ...storage, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config);
  }
}
