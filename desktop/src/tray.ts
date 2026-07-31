import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";

export function createTray(mainWindow: BrowserWindow): Tray {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("OpenCodex");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示 OpenCodex",
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        }
      },
      {
        label: "隐藏 OpenCodex",
        click: () => mainWindow.hide()
      },
      { type: "separator" },
      { label: "退出 OpenCodex", click: () => app.quit() }
    ])
  );
  tray.on("click", () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  return tray;
}
