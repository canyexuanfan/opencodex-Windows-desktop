import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { DesktopBackendSupervisor, type BackendStatus } from "./backend-supervisor.js";
import { installNavigationPolicy } from "./navigation.js";
import { createTray, type TrayController, type TrayStatus } from "./tray.js";

// This must run before app.whenReady so a second process cannot create a window or sidecar.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let tray: TrayController | null = null;
  let isQuitting = false;
  let manualStopRequested = false;
  let recoveryAttempts = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const packagedRoot = app.isPackaged ? path.join(process.resourcesPath, "opencodex") : process.cwd();
  const backend = new DesktopBackendSupervisor({
    cwd: packagedRoot,
    bunExecutable: app.isPackaged ? path.join(packagedRoot, "runtime", "bun.exe") : undefined,
    sidecarEntry: app.isPackaged ? path.join(packagedRoot, "src", "desktop", "entry.ts") : undefined,
  });

  const focusMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  };

  function trayStatus(status: BackendStatus): TrayStatus {
    if (status.state === "ready") return "online";
    if (status.state === "starting") return "starting";
    if (status.state === "failed") return "error";
    return "offline";
  }

  function setTrayStatus(status: BackendStatus): void {
    tray?.setStatus(trayStatus(status));
  }

  async function loadDashboard(port: number): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = `http://127.0.0.1:${port}/`;
    installNavigationPolicy(mainWindow.webContents, new URL(url).origin);
    await mainWindow.loadURL(url);
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }

  async function showOfflineState(): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    await mainWindow.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(
      "<main style=\"font-family:system-ui;padding:48px;color:#243042\"><h1>OpenCodex</h1><p>Proxy is offline. Use the tray to retry or exit.</p></main>"
    )}; document.title = "OpenCodex — Offline";`);
    mainWindow.show();
    mainWindow.focus();
  }

  function scheduleRecovery(): void {
    if (isQuitting || manualStopRequested || recoveryTimer) return;
    if (recoveryAttempts >= 2) {
      tray?.setStatus("error");
      return;
    }
    recoveryAttempts += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void startProxy(false).catch(() => {});
    }, 500 * recoveryAttempts);
  }

  async function startProxy(manual: boolean): Promise<BackendStatus> {
    manualStopRequested = false;
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    }
    setTrayStatus({ state: "starting" });
    try {
      const status = await backend.start();
      if (status.state !== "ready" || !status.port) throw new Error("desktop sidecar did not become ready");
      recoveryAttempts = 0;
      await loadDashboard(status.port);
      return status;
    } catch (error) {
      setTrayStatus({ state: "failed", error: error instanceof Error ? error.message : String(error) });
      try {
        await showOfflineState();
      } catch {
        mainWindow?.show();
      }
      if (!manual) scheduleRecovery();
      throw error;
    }
  }

  async function stopProxy(manual = true): Promise<BackendStatus> {
    manualStopRequested = manual;
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    }
    const status = await backend.stop();
    setTrayStatus(status);
    try {
      await showOfflineState();
    } catch {
      mainWindow?.show();
    }
    return status;
  }

  async function restartProxy(): Promise<BackendStatus> {
    await stopProxy(true);
    manualStopRequested = false;
    return startProxy(true);
  }

  backend.onStatusChange(status => {
    setTrayStatus(status);
    if ((status.state === "stopped" || status.state === "failed") && !manualStopRequested && !isQuitting) {
      scheduleRecovery();
    }
  });
  app.on("second-instance", focusMainWindow);

  function registerLifecycleIpc(): void {
    ipcMain.handle("desktop:get-status", () => backend.getStatus());
    ipcMain.handle("desktop:start-proxy", () => startProxy(true));
    ipcMain.handle("desktop:stop-proxy", () => stopProxy(true));
    ipcMain.handle("desktop:restart-proxy", () => restartProxy());
    ipcMain.handle("desktop:request-exit", () => {
      app.quit();
      return { state: "exiting" };
    });
  }

  function createMainWindow(): BrowserWindow {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

    mainWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(import.meta.dirname, "preload.cjs"),
      },
    });

    installNavigationPolicy(mainWindow.webContents);
    void mainWindow.loadURL("about:blank");
    mainWindow.webContents.on("render-process-gone", () => {
      const port = backend.getStatus().port;
      if (port) setTimeout(() => void loadDashboard(port), 250);
      else void showOfflineState().catch(() => {});
    });
    mainWindow.on("close", event => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    return mainWindow;
  }

  app.on("before-quit", event => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    tray?.destroy();
    tray = null;
    void backend.stop().finally(() => app.quit());
  });

  app.whenReady().then(async () => {
    registerLifecycleIpc();
    const window = createMainWindow();
    tray = createTray(window, {
      start: () => void startProxy(true).catch(() => {}),
      stop: () => void stopProxy(true),
    });
    try {
      await startProxy(false);
    } catch {
      // startProxy has rendered the offline state and scheduled bounded recovery.
    }
  });
}
