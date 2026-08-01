export type DesktopLifecycleApi = {
  readonly getStatus: () => Promise<unknown>;
  readonly startProxy: () => Promise<unknown>;
  readonly stopProxy: () => Promise<unknown>;
  readonly restartProxy: () => Promise<unknown>;
  readonly requestExit: () => Promise<unknown>;
  readonly onStatusChange?: (listener: (status: unknown) => void) => () => void;
};

declare global {
  interface Window {
    /** Fixed, preload-owned lifecycle bridge exposed only by the Electron host. */
    readonly openCodexDesktop?: DesktopLifecycleApi;
  }
}

export function getDesktopLifecycleApi(): DesktopLifecycleApi | null {
  if (typeof window === "undefined") return null;
  return window.openCodexDesktop ?? null;
}
