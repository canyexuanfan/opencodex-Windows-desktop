import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = {
  getStatus: "desktop:get-status",
  startProxy: "desktop:start-proxy",
  stopProxy: "desktop:stop-proxy",
  restartProxy: "desktop:restart-proxy",
  requestExit: "desktop:request-exit"
} as const;

export type DesktopLifecycleApi = {
  readonly getStatus: () => Promise<unknown>;
  readonly startProxy: () => Promise<unknown>;
  readonly stopProxy: () => Promise<unknown>;
  readonly restartProxy: () => Promise<unknown>;
  readonly requestExit: () => Promise<unknown>;
};

const api: DesktopLifecycleApi = {
  getStatus: () => ipcRenderer.invoke(CHANNELS.getStatus),
  startProxy: () => ipcRenderer.invoke(CHANNELS.startProxy),
  stopProxy: () => ipcRenderer.invoke(CHANNELS.stopProxy),
  restartProxy: () => ipcRenderer.invoke(CHANNELS.restartProxy),
  requestExit: () => ipcRenderer.invoke(CHANNELS.requestExit)
};

contextBridge.exposeInMainWorld("openCodexDesktop", api);
