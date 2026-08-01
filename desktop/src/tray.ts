import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";

export type TrayStatus = "online" | "offline" | "error" | "starting";
export type TrayOwnership = "desktop" | "external" | undefined;

export type TrayActions = {
  readonly start: () => void;
  readonly stop: () => void;
  readonly restart: () => void;
};

export type TrayController = {
  readonly tray: Tray;
  setStatus: (status: TrayStatus) => void;
  setOwnership: (ownership: TrayOwnership) => void;
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
  let ownership: TrayOwnership;

  const rebuildMenu = (): void => {
    const baseStatusLabel = status === "online"
      ? "\u72b6\u6001\uff1a\u5728\u7ebf"
      : status === "starting" ? "\u72b6\u6001\uff1a\u542f\u52a8\u4e2d" : status === "error" ? "\u72b6\u6001\uff1a\u9519\u8bef" : "\u72b6\u6001\uff1a\u79bb\u7ebf";
    const statusLabel = ownership === "external" ? `${baseStatusLabel}\uff08\u5916\u90e8 CLI\uff09` : baseStatusLabel;
    const ownsLifecycle = ownership !== "external";
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: "separator" },
      {
        label: "\u663e\u793a OpenCodex",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { label: "\u9690\u85cf OpenCodex", click: () => mainWindow.hide() },
      { label: "\u542f\u52a8\u4ee3\u7406", click: actions.start },
      { label: "\u505c\u6b62\u4ee3\u7406", enabled: ownsLifecycle, click: actions.stop },
      { label: "\u91cd\u542f\u4ee3\u7406", enabled: ownsLifecycle, click: actions.restart },
      { type: "separator" },
      { label: "\u9000\u51fa OpenCodex", click: () => app.quit() },
    ]));
    tray.setImage(iconForStatus(status));
    tray.setToolTip(`OpenCodex \u00b7 ${statusLabel.slice(3)}`);
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
    setOwnership(nextOwnership) {
      ownership = nextOwnership;
      rebuildMenu();
    },
    destroy: () => tray.destroy(),
  };
}
