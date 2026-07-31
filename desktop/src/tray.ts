import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";

export type TrayStatus = "online" | "offline" | "error" | "starting";

export type TrayActions = {
  readonly start: () => void;
  readonly stop: () => void;
};

export type TrayController = {
  readonly tray: Tray;
  setStatus: (status: TrayStatus) => void;
  destroy: () => void;
};

function iconForStatus(status: TrayStatus) {
  const filename = status === "online"
    ? "opencodex-tray-online.ico"
    : status === "error" ? "opencodex-tray-warning.ico" : "opencodex-tray-offline.ico";
  const candidates = [
    path.join(process.resourcesPath, "tray", filename),
    path.resolve(process.cwd(), "src", "tray", "assets", filename),
  ];
  const file = candidates.find(candidate => existsSync(candidate));
  return file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

export function createTray(mainWindow: BrowserWindow, actions: TrayActions): TrayController {
  const tray = new Tray(iconForStatus("offline"));
  let status: TrayStatus = "offline";

  const rebuildMenu = (): void => {
    const statusLabel = status === "online"
      ? "状态：在线"
      : status === "starting" ? "状态：启动中" : status === "error" ? "状态：错误" : "状态：离线";
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: "separator" },
      {
        label: "显示 OpenCodex",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { label: "隐藏 OpenCodex", click: () => mainWindow.hide() },
      { label: "启动代理", click: actions.start },
      { label: "停止代理", click: actions.stop },
      { type: "separator" },
      { label: "退出 OpenCodex", click: () => app.quit() },
    ]));
    tray.setImage(iconForStatus(status));
    tray.setToolTip(`OpenCodex · ${statusLabel.slice(3)}`);
  };

  rebuildMenu();
  tray.on("click", () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return {
    tray,
    setStatus(nextStatus) {
      status = nextStatus;
      rebuildMenu();
    },
    destroy: () => tray.destroy(),
  };
}
