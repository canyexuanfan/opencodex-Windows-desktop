import { drainAndShutdown, startServer } from "../server";
import { findLiveProxy } from "../server/proxy-liveness";
import { isAddrInUse } from "../server/ports";
import { removePid, removeRuntimePort, writePid, writeRuntimePort } from "../config";
import { syncModelsToCodex } from "../codex/sync";
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
let holdTimer: ReturnType<typeof setInterval> | undefined;

function cleanupRuntimeFiles(): void {
  if (cleanupDone || !ownsServer) return;
  cleanupDone = true;
  removeRuntimePort(process.pid);
  removePid(process.pid);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (holdTimer) clearInterval(holdTimer);
  try {
    if (server) await drainAndShutdown(server, 5_000);
  } finally {
    cleanupRuntimeFiles();
    process.exitCode = exitCode;
  }
}

async function main(): Promise<void> {
  try {
    const existing = await findLiveProxy();
    if (existing) {
      const ready: DesktopReadyMessage = {
        type: "ready",
        pid: existing.pid ?? process.pid,
        port: existing.port,
        hostname: DESKTOP_HOSTNAME,
        version: VERSION,
      };
      console.log(formatDesktopReadyMessage(ready));
      // Keep a lightweight lease so Electron can stop only this helper. The existing proxy is
      // external-owned and is never stopped or removed by this process.
      holdTimer = setInterval(() => {}, 60_000);
      return;
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        server = startServer(0, { hostname: DESKTOP_HOSTNAME });
        break;
      } catch (error) {
        if (!isAddrInUse(error) || attempt >= 2) throw error;
        await Bun.sleep(50 * (attempt + 1));
      }
    }
    ownsServer = true;
    const port = server.port;
    if (!port || port <= 0) throw new Error("desktop sidecar did not receive a concrete port");

    writePid(process.pid);
    writeRuntimePort({ pid: process.pid, port, hostname: DESKTOP_HOSTNAME });

    // Keep the existing Codex/catalog synchronization path. A provider/network failure must
    // not corrupt the ready contract; the dashboard can retry synchronization after startup.
    await syncModelsToCodex(port).catch(() => {});

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

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("SIGHUP", () => void shutdown());
process.once("exit", cleanupRuntimeFiles);
void main();
