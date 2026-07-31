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
    mainWindow.once("ready-to-show", () => mainWindow?.show());
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

  app.on("before-quit", () => {
    isQuitting = true;
    tray?.destroy();
    tray = null;
  });

  app.whenReady().then(() => {
    registerLifecycleIpc();
    const window = createMainWindow();
    tray = createTray(window);
  });
}
