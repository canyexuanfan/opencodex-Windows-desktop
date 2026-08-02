import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { DesktopBackendSupervisor, type BackendStatus } from "./backend-supervisor.js";
import { installNavigationPolicy, type NavigationPolicy } from "./navigation.js";
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
  let navigationPolicy: NavigationPolicy | null = null;
  const packagedRoot = app.isPackaged ? path.join(process.resourcesPath, "opencodex") : process.cwd();
  const backend = new DesktopBackendSupervisor({
    cwd: packagedRoot,
    bunExecutable: app.isPackaged ? path.join(packagedRoot, "runtime", "bun.exe") : undefined,
    sidecarEntry: app.isPackaged ? path.join(packagedRoot, "src", "desktop", "entry.ts") : undefined,
    desktopVersion: app.getVersion(),
  });

  const focusMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  };

  function desktopIconPath(): string | undefined {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, "tray", "opencodex-tray-online.ico")]
      : [
        path.resolve(process.cwd(), "src", "tray", "assets", "opencodex-tray-online.ico"),
        path.resolve(process.cwd(), "..", "src", "tray", "assets", "opencodex-tray-online.ico"),
      ];
    return candidates.find(candidate => existsSync(candidate));
  }

  function trayStatus(status: BackendStatus): TrayStatus {
    if (status.state === "ready") return "online";
    if (status.state === "starting") return "starting";
    if (status.state === "failed") return "error";
    return "offline";
  }

  function setTrayStatus(status: BackendStatus): void {
    tray?.setOwnership(status.ownership);
    tray?.setStatus(trayStatus(status));
  }

  function publishBackendStatus(status: BackendStatus): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("desktop:status-changed", status);
  }

  function currentDashboardHash(): string {
    if (!mainWindow || mainWindow.isDestroyed()) return "";
    try {
      const currentUrl = new URL(mainWindow.webContents.getURL());
      if (currentUrl.protocol !== "http:" || currentUrl.hostname !== "127.0.0.1") return "";
      return currentUrl.hash;
    } catch {
      return "";
    }
  }

  function dashboardUrl(port: number, hash = ""): string {
    const url = new URL(`http://127.0.0.1:${port}/`);
    if (hash) url.hash = hash.startsWith("#") ? hash.slice(1) : hash;
    return url.toString();
  }

  async function loadDashboard(port: number, hash = currentDashboardHash()): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = dashboardUrl(port, hash);
    navigationPolicy?.setExpectedOrigin(new URL(url).origin);
    await mainWindow.loadURL(url);
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }

  async function showOfflineState(): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const offlineHtml = `<style>
      :root{font-family:system-ui;color:#243042;background:#f6f8fb}body{margin:0}
      main{max-width:560px;margin:12vh auto;padding:42px;border:1px solid #dbe2ea;border-radius:18px;background:#fff;box-shadow:0 18px 48px #25364a1a}
      p{line-height:1.65;color:#566579}.actions{display:flex;gap:12px;margin-top:28px}
      button{border:1px solid #bac7d5;border-radius:10px;background:#fff;color:#243042;padding:10px 18px;font:inherit;cursor:pointer;transition:.15s ease}
      button:hover:not(:disabled){border-color:#4676d7;background:#eef4ff}button:focus-visible{outline:3px solid #8cb4ff;outline-offset:2px}
      button:disabled{opacity:.58;cursor:wait}#start{background:#315fbd;border-color:#315fbd;color:#fff}#start:hover:not(:disabled){background:#254d9e}
    </style><main><h1>OpenCodex</h1><p>代理当前已停止。你可以重新启动代理，或安全退出桌面端。</p><div class="actions"><button id="start" type="button">启动代理</button><button id="exit" type="button">退出</button></div></main>`;
    await mainWindow.webContents.executeJavaScript(`
      document.body.innerHTML = ${JSON.stringify(offlineHtml)};
      document.title = "OpenCodex — Offline";
      document.getElementById("start")?.addEventListener("click", async () => {
        const button = document.getElementById("start");
        if (button) { button.disabled = true; button.textContent = "正在启动…"; }
        try { await window.openCodexDesktop.startProxy(); }
        catch { if (button) { button.disabled = false; button.textContent = "重试启动"; } }
      });
      document.getElementById("exit")?.addEventListener("click", () => window.openCodexDesktop.requestExit());
    `);
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
    let status: BackendStatus;
    try {
      status = await backend.stop();
    } catch (error) {
      manualStopRequested = false;
      scheduleRecovery();
      throw error;
    }
    setTrayStatus(status);
    publishBackendStatus(status);
    mainWindow?.show();
    return status;
  }

  async function restartProxy(): Promise<BackendStatus> {
    await stopProxy(true);
    manualStopRequested = false;
    return startProxy(true);
  }

  backend.onStatusChange(status => {
    setTrayStatus(status);
    publishBackendStatus(status);
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
    const icon = desktopIconPath();

    mainWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      autoHideMenuBar: true,
      ...(icon ? { icon } : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(import.meta.dirname, "preload.cjs"),
      },
    });
    mainWindow.setMenuBarVisibility(false);

    navigationPolicy = installNavigationPolicy(mainWindow.webContents);
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
      navigationPolicy?.dispose();
      navigationPolicy = null;
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
    void backend.stop().then(() => {
      tray?.destroy();
      tray = null;
      app.quit();
    }).catch(error => {
      isQuitting = false;
      scheduleRecovery();
      const message = error instanceof Error ? error.message : String(error);
      tray?.setStatus("error");
      focusMainWindow();
      dialog.showErrorBox("OpenCodex 无法安全退出", `${message}\n\n代理仍保持运行，Codex 路由未被留在离线端口。`);
    });
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerLifecycleIpc();
    const window = createMainWindow();
    tray = createTray(window, {
      start: () => void startProxy(true).catch(() => {}),
      stop: () => void stopProxy(true),
      restart: () => void restartProxy().catch(() => {}),
    });
    try {
      await startProxy(false);
    } catch {
      // startProxy has rendered the offline state and scheduled bounded recovery.
    }
  });
}
