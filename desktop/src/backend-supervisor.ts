export type BackendState = "not-started" | "starting" | "ready" | "stopped" | "failed";

export interface BackendStatus {
  readonly state: BackendState;
  readonly port?: number;
  readonly error?: string;
}

/**
 * Stage 1 deliberately contains no sidecar startup. The supervisor is the
 * single seam that later stages will use so the Electron host never grows a
 * second backend implementation.
 */
export class DesktopBackendSupervisor {
  private status: BackendStatus = { state: "not-started" };

  getStatus(): BackendStatus {
    return this.status;
  }

  async start(): Promise<BackendStatus> {
    throw new Error("Desktop backend startup is not enabled before stage 2");
  }

  async stop(): Promise<BackendStatus> {
    this.status = { state: "stopped" };
    return this.status;
  }
}
