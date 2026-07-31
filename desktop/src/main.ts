import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { DesktopBackendSupervisor } from "./backend-supervisor.js";
import { installNavigationPolicy } from "./navigation.js";
import { createTray } from "./tray.js";

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let tray: ReturnType<typeof createTray> | null = null;
  let isQuitting = false;
  const backend = new DesktopBackendSupervisor();

  const focusMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  };

  app.on("second-instance", focusMainWindow);

  function registerLifecycleIpc(): void {
    ipcMain.handle("desktop:get-status", () => backend.getStatus());
    ipcMain.handle("desktop:start-proxy", () => backend.start());
    ipcMain.handle("desktop:stop-proxy", () => backend.stop());
    ipcMain.handle("desktop:restart-proxy", async () => {
      await backend.stop();
      return backend.start();
    });
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
        preload: path.join(import.meta.dirname, "preload.js")
      }
    });

    installNavigationPolicy(mainWindow.webContents);
    mainWindow.loadURL("about:blank");
    mainWindow.on("close", (event) => {
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
      "<main style=\"font-family:system-ui;padding:48px;color:#243042\"><h1>OpenCodex</h1><p>代理暂时离线，请从托盘重试或退出。</p></main>"
    )}; document.title = "OpenCodex — 离线";`);
    mainWindow.show();
    mainWindow.focus();
  }

  app.on("before-quit", () => {
    isQuitting = true;
    tray?.destroy();
    tray = null;
  });

  app.whenReady().then(async () => {
    registerLifecycleIpc();
    const window = createMainWindow();
    try {
      const status = await backend.start();
      if (status.state !== "ready" || !status.port) throw new Error("desktop sidecar did not become ready");
      await loadDashboard(status.port);
    } catch {
      await showOfflineState();
    }
    tray = createTray(window);
  });
}
