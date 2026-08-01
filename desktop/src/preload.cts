import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = {
  getStatus: "desktop:get-status",
  startProxy: "desktop:start-proxy",
  stopProxy: "desktop:stop-proxy",
  restartProxy: "desktop:restart-proxy",
  requestExit: "desktop:request-exit",
  statusChanged: "desktop:status-changed",
} as const;

const api = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.getStatus),
  startProxy: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.startProxy),
  stopProxy: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.stopProxy),
  restartProxy: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.restartProxy),
  requestExit: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.requestExit),
  onStatusChange: (listener: (status: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown): void => listener(status);
    ipcRenderer.on(CHANNELS.statusChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.statusChanged, handler);
  },
};

contextBridge.exposeInMainWorld("openCodexDesktop", api);
