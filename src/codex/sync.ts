import { currentExternalCodexModelProvider, injectCodexConfig, restoreNativeCodex } from "./inject";
import { printProjectCodexConfigWarnings, groupProjectCodexConfigWarningsByPath, type ProjectCodexConfigWarning } from "./project-config-warnings";
import { refreshCodexModelCatalog } from "./refresh";
import { applyProxyEnv, loadConfig } from "../config";
import type { OcxConfig } from "../types";
import { collectOrcaCodexHomeDiagnostic } from "./home";
import { summarizeComboCatalogOmissions, type ComboCatalogOmission } from "./catalog/aggregation";
import { findLiveProxy, proxyIdentityAt } from "../server/proxy-liveness";

export interface CodexSyncResult {
  ok: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
  message: string;
  warning?: string;
  comboOmissions?: ComboCatalogOmission[];
  nativeSubagentDefaultsWarning?: string;
  projectConfigWarnings?: ProjectCodexConfigWarning[];
  projectConfigGrouped?: { path: string; issues: string[]; bypass: string }[];
}

export interface CodexSyncDeps {
  refreshCodexModelCatalog: typeof refreshCodexModelCatalog;
  injectCodexConfig: typeof injectCodexConfig;
  currentExternalCodexModelProvider?: typeof currentExternalCodexModelProvider;
  collectCodexHomeDiagnostic?: typeof collectOrcaCodexHomeDiagnostic;
  /** Identity-checked liveness gate. Tests may provide a deterministic live proxy. */
  findLiveProxy?: typeof findLiveProxy;
  /** Restore marker-owned routing when the liveness gate finds no proxy. */
  restoreNativeCodex?: typeof restoreNativeCodex;
}

export interface CodexSyncOptions {
  /**
   * The management API is executing inside the serving proxy process. Passing its listener port
   * skips the initial runtime-file lookup, but a PID-matched /healthz probe still runs immediately
   * before injection so a stopped or replaced listener cannot receive marker-owned routing.
   */
  trustedServerPort?: number;
  /** Test seam for the final trusted-port /healthz probe. */
  proxyIdentityAt?: typeof proxyIdentityAt;
}

const defaultDeps: CodexSyncDeps = {
  refreshCodexModelCatalog,
  injectCodexConfig,
};

function reportCodexHomeTarget(
  log: Pick<Console, "log" | "error"> | null,
  collectDiagnostic: typeof collectOrcaCodexHomeDiagnostic,
): void {
  if (!log) return;
  const target = collectDiagnostic();
  log.log(`   Target Codex home: ${target.effectiveCodexHome}`);
  if (target.warning) {
    log.error(`WARNING: ${target.warning}`);
    log.error(`Action: ${target.action}`);
  }
}

export async function syncModelsToCodex(
  port?: number,
  config: OcxConfig = loadConfig(),
  log: Pick<Console, "log" | "error"> | null = console,
  deps: CodexSyncDeps = defaultDeps,
  options: CodexSyncOptions = {},
): Promise<CodexSyncResult> {
  const externalProvider = (deps.currentExternalCodexModelProvider ?? currentExternalCodexModelProvider)();
  if (externalProvider) {
    // External providers are intentionally preserved and do not require a local proxy. The
    // endpoint in this diagnostic is only advisory; do not let it become a config mutation.
    const result = await deps.injectCodexConfig(port ?? config.port ?? 10100, config, {});
    log?.log(result.message);
    reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
    return {
      ok: result.success,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message: result.message,
      ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    };
  }

  // Never write a marker-owned Codex route unless an identity-checked OpenCodex proxy is alive.
  // The old `port ?? config.port ?? 10100` fallback could persist a dead dynamic port after a
  // crash/restart. `findLiveProxy` resolves runtime-port.json first and verifies /healthz, so the
  // returned port is the single source of truth even when the configured port has drifted.
  const locateLive = deps.findLiveProxy ?? findLiveProxy;
  const live = options.trustedServerPort !== undefined
    ? { pid: process.pid, port: options.trustedServerPort, hostname: config.hostname, source: "runtime" as const }
    : await locateLive({
      configFn: () => ({ port: config.port, hostname: config.hostname }),
    });
  if (!live) {
    const restored = (deps.restoreNativeCodex ?? restoreNativeCodex)();
    const message = restored.success
      ? "Codex sync skipped: no healthy OpenCodex proxy found; native Codex routing was restored. Start the proxy before syncing again."
      : `Codex sync skipped: no healthy OpenCodex proxy found, and native Codex routing could not be restored: ${restored.message}`;
    log?.error(message);
    reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
    return {
      ok: false,
      added: 0,
      catalogPath: null,
      catalogExists: false,
      catalogWritten: false,
      cacheSynced: false,
      message,
    };
  }
  const initialPort = live.port;
  if (port !== undefined && port !== initialPort) {
    log?.error(`Codex sync corrected a stale port ${port} to the live OpenCodex port ${initialPort}.`);
  }

  applyProxyEnv(config); // `ocx ensure`/`ocx sync` fetch provider models outside the server process
  let added = 0;
  let catalogPath: string | null = null;
  let catalogPathForInjection: string | null | undefined;
  let catalogExists = false;
  let catalogWritten = false;
  let cacheSynced = false;
  let warning: string | undefined;
  let comboOmissions: ComboCatalogOmission[] = [];

  try {
    const cat = await deps.refreshCodexModelCatalog(config);
    added = cat.added;
    catalogExists = cat.catalogExists;
    catalogWritten = cat.catalogWritten;
    cacheSynced = cat.cacheSynced;
    catalogPathForInjection = cat.catalogExists ? cat.path : null;
    catalogPath = catalogPathForInjection;
    comboOmissions = cat.comboOmissions ?? [];
    if (cat.added > 0) {
      log?.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (!cat.catalogExists) {
      warning = "catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.";
      log?.error(warning);
    }
    if (comboOmissions.length > 0) {
      // Individual omission lines already went through console.warn during gather;
      // keep a single summary on the sync logger to avoid duplicate stderr noise.
      const summary = summarizeComboCatalogOmissions(comboOmissions);
      log?.error(summary);
      warning = warning ? `${warning} ${summary}` : summary;
    }
  } catch (e) {
    warning = `catalog sync skipped: ${e instanceof Error ? e.message : String(e)}`;
    log?.error(warning);
  }

  // The first liveness check intentionally happens before the potentially slow catalog refresh,
  // but that check is not a lease. The proxy can stop (and restore Codex) while the catalog is
  // being fetched; injecting the original port here would recreate the dead-route bug. Recheck
  // immediately before the file write and use the newly observed port when a soft start moved.
  const finalLive = options.trustedServerPort !== undefined
    ? await (options.proxyIdentityAt ?? proxyIdentityAt)(
      options.trustedServerPort,
      { hostname: config.hostname, expectedPid: process.pid },
    ).then(identity => identity
      ? { pid: identity.pid, port: options.trustedServerPort!, hostname: config.hostname, source: "runtime" as const }
      : null)
    : await locateLive({
      configFn: () => ({ port: config.port, hostname: config.hostname }),
    });
  if (!finalLive) {
    const restored = (deps.restoreNativeCodex ?? restoreNativeCodex)();
    const message = restored.success
      ? "Codex sync skipped: OpenCodex proxy stopped during catalog refresh; native Codex routing was restored."
      : `Codex sync skipped: OpenCodex proxy stopped during catalog refresh, and native Codex routing could not be restored: ${restored.message}`;
    log?.error(message);
    reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
    return {
      ok: false,
      added,
      catalogPath,
      catalogExists,
      catalogWritten,
      cacheSynced,
      message,
      ...(warning ? { warning } : {}),
      ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    };
  }
  const p = finalLive.port;
  if (p !== initialPort) {
    log?.error(`Codex sync refreshed the live OpenCodex port from ${initialPort} to ${p}.`);
  }

  const result = await deps.injectCodexConfig(p, config, { catalogPath: catalogPathForInjection });
  log?.log(result.message);
  reportCodexHomeTarget(log, deps.collectCodexHomeDiagnostic ?? collectOrcaCodexHomeDiagnostic);
  const projectConfigWarnings = printProjectCodexConfigWarnings(log, { cwd: process.cwd() });
  return {
    ok: result.success,
    added,
    catalogPath,
    catalogExists,
    catalogWritten,
    cacheSynced,
    message: result.message,
    ...(warning ? { warning } : {}),
    ...(comboOmissions.length > 0 ? { comboOmissions } : {}),
    ...(result.nativeSubagentDefaultsWarning ? { nativeSubagentDefaultsWarning: result.nativeSubagentDefaultsWarning } : {}),
    ...(projectConfigWarnings.length > 0 ? {
      projectConfigWarnings,
      projectConfigGrouped: groupProjectCodexConfigWarningsByPath(projectConfigWarnings),
    } : {}),
  };
}
