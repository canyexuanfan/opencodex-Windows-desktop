import { drainAndShutdown, startServer } from "../server";
import { findAvailablePort, isAddrInUse, shouldPersistSelectedPort } from "../server/ports";
import { loadConfig, removePid, removeRuntimePort, saveConfig, writePid, writeRuntimePort } from "../config";
import {
  currentExternalCodexModelProvider,
  isCodexRoutingInjected,
  restoreNativeCodex,
  shouldInjectApiAuthHeader,
} from "../codex/inject";
import { reconcileJournal } from "../codex/journal";
import {
  blockCodexSyncsForShutdown,
  syncModelsToCodex,
  unblockCodexSyncsAfterRefusal,
  waitForActiveCodexSyncs,
} from "../codex/sync";
import { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { stripGrokConfig } from "../grok/inject";
import { scheduleCatalogPrewarm } from "../cli/catalog-prewarm";
import { installCrashGuards } from "../lib/crash-guard";
import { startTokenGuardian, type TokenGuardianHandle } from "../oauth/token-guardian";
import { serviceEnvironmentOwnedHere } from "../service";
import { injectSystemEnv, installShellHook, revertSystemEnv } from "../server/system-env";
import { VERSION } from "../server/management-api";
import {
  DESKTOP_HOSTNAME,
  formatDesktopReadyMessage,
  type DesktopReadyMessage,
} from "./ready";

let server: ReturnType<typeof startServer> | undefined;
let shuttingDown = false;
let cleanupDone = false;
let ownsServer = false;
let codexRoutingOwned = false;
let integrationEnvironmentOwned = false;
let grokRoutingOwned = false;
let tokenGuardian: TokenGuardianHandle | undefined;
let historyGuardian: ReturnType<typeof startHistoryMigrationGuardian> | undefined;

export function formatDesktopStopRefusedMessage(detail: string): string {
  return JSON.stringify({
    type: "stop-refused",
    error: `desktop sidecar could not complete a safe shutdown: ${detail}`,
  });
}

export function formatDesktopStoppedMessage(): string {
  return JSON.stringify({ type: "stopped" });
}

type DesktopShutdownActions = {
  blockCodexSyncs(): void;
  waitForCodexSyncs(): Promise<boolean>;
  unblockCodexSyncs(): void;
  restoreCodex(): { success: boolean; message: string };
  reportRefusal(detail: string): void;
  stopBackground(): void;
  restoreIntegrations(): { success: boolean; message: string };
  drainServer(): Promise<void>;
  cleanupRuntime(): void;
  confirmStop(): void;
  exit(code: number): void;
};

export async function runDesktopShutdownTransaction(
  state: { ownsServer: boolean; codexRoutingOwned: boolean; exitCode: number },
  actions: DesktopShutdownActions,
): Promise<"stopped" | "refused"> {
  let syncGateHeld = false;
  if (state.ownsServer) {
    actions.blockCodexSyncs();
    syncGateHeld = true;
    const syncsSettled = await actions.waitForCodexSyncs();
    if (!syncsSettled) {
      actions.reportRefusal("in-flight Codex sync did not finish before the shutdown deadline");
      actions.unblockCodexSyncs();
      return "refused";
    }
    try {
      const integrations = actions.restoreIntegrations();
      if (!integrations.success) {
        actions.reportRefusal(integrations.message);
        actions.unblockCodexSyncs();
        return "refused";
      }
    } catch (error) {
      actions.reportRefusal(error instanceof Error ? error.message : String(error));
      actions.unblockCodexSyncs();
      return "refused";
    }
  }

  if (state.ownsServer && state.codexRoutingOwned) {
    try {
      const restored = actions.restoreCodex();
      if (!restored.success) {
        actions.reportRefusal(restored.message);
        if (syncGateHeld) actions.unblockCodexSyncs();
        return "refused";
      }
    } catch (error) {
      actions.reportRefusal(error instanceof Error ? error.message : String(error));
      if (syncGateHeld) actions.unblockCodexSyncs();
      return "refused";
    }
  }

  actions.stopBackground();
  let safelyStopped = false;
  try {
    await actions.drainServer();
    actions.cleanupRuntime();
    safelyStopped = true;
  } finally {
    if (!safelyStopped) {
      try { actions.cleanupRuntime(); } catch { /* exit handler retries best-effort cleanup */ }
    } else {
      actions.confirmStop();
    }
    actions.exit(safelyStopped ? state.exitCode : 1);
  }
  return "stopped";
}

function cleanupRuntimeFiles(): void {
  if (cleanupDone || !ownsServer) return;
  cleanupDone = true;
  removeRuntimePort(process.pid);
  removePid(process.pid);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // A route restore is the commit point for stopping an owned proxy. A refusal runs none of the
  // background, integration, listener, runtime-file, or process teardown actions below.
  const outcome = await runDesktopShutdownTransaction(
    { ownsServer, codexRoutingOwned, exitCode },
    {
      blockCodexSyncs: blockCodexSyncsForShutdown,
      waitForCodexSyncs: () => waitForActiveCodexSyncs(5_000),
      unblockCodexSyncs: unblockCodexSyncsAfterRefusal,
      restoreCodex: restoreNativeCodex,
      reportRefusal: detail => console.log(formatDesktopStopRefusedMessage(detail)),
      stopBackground: () => {
        try { tokenGuardian?.stop(); } catch { /* best-effort */ }
        try { historyGuardian?.stop(); } catch { /* best-effort */ }
      },
      restoreIntegrations: () => {
        if (!integrationEnvironmentOwned) {
          return { success: true, message: "desktop did not own shared integrations" };
        }
        const systemEnv = revertSystemEnv();
        if (
          process.platform === "darwin"
          && !systemEnv.reverted
          && systemEnv.reason !== "no tracking file"
        ) {
          return { success: false, message: `system environment restore failed: ${systemEnv.reason}` };
        }
        if (grokRoutingOwned) {
          const grok = stripGrokConfig();
          if (!grok.ok) return { success: false, message: grok.message };
        }
        return { success: true, message: "desktop integrations restored" };
      },
      drainServer: async () => {
        if (server) await drainAndShutdown(server, 5_000);
      },
      cleanupRuntime: cleanupRuntimeFiles,
      confirmStop: () => console.log(formatDesktopStoppedMessage()),
      // stdin stays open while Electron supervises this helper; an accepted stop must exit.
      exit: code => process.exit(code),
    },
  );
  if (outcome === "refused") shuttingDown = false;
}

async function main(): Promise<void> {
  try {
    // A forced termination cannot run the shutdown hook. If the previous desktop sidecar left
    // its marker-owned loopback route behind, recover native Codex before creating a new route.
    // External-proxy adoption belongs exclusively to Electron's loopback-compatible supervisor;
    // this helper always owns the listener it reports as desktop-owned.
    if (!currentExternalCodexModelProvider()) reconcileJournal();
    if (isCodexRoutingInjected()) {
      const recovered = restoreNativeCodex();
      if (!recovered.success) {
        throw new Error(`stale Codex routing could not be restored: ${recovered.message}`);
      }
      console.log(`desktop sidecar recovered stale Codex routing: ${recovered.message}`);
    }

    const diskConfig = loadConfig();
    const config = { ...diskConfig, hostname: DESKTOP_HOSTNAME };
    const preferredPort = diskConfig.port ?? 10100;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const selectedPort = await findAvailablePort(preferredPort, DESKTOP_HOSTNAME, {
          preferRetryMs: preferredPort > 0 ? 750 : 0,
          preferRetryIntervalMs: 50,
        });
        server = startServer(selectedPort, { hostname: DESKTOP_HOSTNAME });
        scheduleCatalogPrewarm();
        break;
      } catch (error) {
        if (!isAddrInUse(error) || attempt >= 2) throw error;
        await Bun.sleep(50 * (attempt + 1));
      }
    }
    ownsServer = true;
    installCrashGuards();
    const port = server.port;
    if (!port || port <= 0) throw new Error("desktop sidecar did not receive a concrete port");
    if (shouldPersistSelectedPort(diskConfig.port, port, preferredPort)) {
      diskConfig.port = port;
      config.port = port;
      saveConfig(diskConfig);
    }

    writePid(process.pid);
    writeRuntimePort({ pid: process.pid, port, hostname: DESKTOP_HOSTNAME });

    // The desktop listener is always loopback even when a previous CLI config saved a different
    // hostname. Use the actual bind identity for every integration derived during this lease.
    tokenGuardian = startTokenGuardian();
    integrationEnvironmentOwned = serviceEnvironmentOwnedHere();
    if (integrationEnvironmentOwned) {
      await injectSystemEnv(port, config).catch(() => {});
      installShellHook();
    }

    // Keep the existing Codex/catalog synchronization path. A provider/network failure must
    // not corrupt the ready contract; the dashboard can retry synchronization after startup.
    await syncModelsToCodex(port, config).catch(() => {});
    codexRoutingOwned = !currentExternalCodexModelProvider() && isCodexRoutingInjected();
    if (
      codexRoutingOwned
      && !shouldInjectApiAuthHeader(config)
      && config.syncResumeHistory !== false
    ) {
      historyGuardian = startHistoryMigrationGuardian();
    }

    try {
      const { fetchAllModels } = await import("../server/management-api");
      const { visibleNativeSlugs, filterCatalogVisibleModels } = await import("../codex/catalog");
      const models = filterCatalogVisibleModels(await fetchAllModels(config), config);
      buildDesktop3pRegistry(
        [...visibleNativeSlugs(config)],
        models.map(model => ({
          provider: model.provider,
          id: model.id,
          contextWindow: model.contextWindow,
        })),
        config.claudeCode?.desktopProfile,
      );
    } catch { /* best-effort; the registry rebuilds on the first /v1/models call */ }

    if (integrationEnvironmentOwned) {
      try {
        const { syncGrokConfig } = await import("../grok/sync");
        const result = await syncGrokConfig(port, config, { hostname: DESKTOP_HOSTNAME });
        grokRoutingOwned = result.ok && result.changed;
        if (result.changed) console.log("desktop sidecar updated the Grok Build config");
        else if (!result.ok) console.error(result.message);
      } catch (error) {
        console.error(`desktop sidecar could not sync Grok Build config: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const ready: DesktopReadyMessage = {
      type: "ready",
      pid: process.pid,
      port,
      hostname: DESKTOP_HOSTNAME,
      version: VERSION,
    };
    console.log(formatDesktopReadyMessage(ready));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`desktop sidecar failed: ${message}`);
    await shutdown(1);
  }
}

if (import.meta.main) {
  // Keep handlers installed: a refused restore deliberately keeps the process alive and a later
  // stop attempt must be able to retry after the operator fixes the Codex config conflict.
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
  process.once("exit", cleanupRuntimeFiles);
  process.stdin.setEncoding("utf8");
  let stdinBuffer = "";
  process.stdin.on("data", (chunk: string) => {
    stdinBuffer += chunk;
    const lines = stdinBuffer.split(/\r?\n/);
    stdinBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "stop") void shutdown();
    }
  });
  void main();
}
