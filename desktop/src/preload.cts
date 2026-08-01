import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = {
  getStatus: "desktop:get-status",
  startProxy: "desktop:start-proxy",
  stopProxy: "desktop:stop-proxy",
  restartProxy: "desktop:restart-proxy",
  requestExit: "desktop:request-exit",
} as const;

const api = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.getStatus),
  startProxy: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.startProxy),
  stopProxy: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.stopProxy),
  restartProxy: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.restartProxy),
  requestExit: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.requestExit),
};

contextBridge.exposeInMainWorld("openCodexDesktop", api);
