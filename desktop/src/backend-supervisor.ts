import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";

type DesktopReadyMessage = {
  readonly type: "ready";
  readonly pid: number;
  readonly port: number;
  readonly hostname: "127.0.0.1";
  readonly version: string;
};

function parseDesktopReadyLine(line: string): DesktopReadyMessage | null {
  try {
    const value: unknown = JSON.parse(line.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.type !== "ready" || candidate.hostname !== "127.0.0.1") return null;
    if (!Number.isSafeInteger(candidate.pid) || Number(candidate.pid) <= 0) return null;
    if (!Number.isInteger(candidate.port) || Number(candidate.port) <= 0 || Number(candidate.port) > 65535) return null;
    if (typeof candidate.version !== "string" || candidate.version.trim().length === 0) return null;
    return candidate as unknown as DesktopReadyMessage;
  } catch {
    return null;
  }
}

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
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private ready: DesktopReadyMessage | null = null;

  getStatus(): BackendStatus {
    return this.ready
      ? { ...this.status, port: this.ready.port }
      : this.status;
  }

  async start(): Promise<BackendStatus> {
    if (this.child && !this.child.killed) return this.getStatus();

    const bunExecutable = process.env.OPENCODEX_BUN_EXECUTABLE ?? "bun";
    const entry = process.env.OPENCODEX_DESKTOP_SIDECAR
      ?? path.resolve(process.cwd(), "src/desktop/entry.ts");
    this.status = { state: "starting" };
    this.ready = null;

    const child = spawn(bunExecutable, [entry], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCODEX_DESKTOP_MODE: "1" },
    });
    this.child = child;

    return await new Promise<BackendStatus>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      const fail = (error: Error): void => {
        this.status = { state: "failed", error: error.message };
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const message = parseDesktopReadyLine(line);
          if (!message) continue;
          if (this.ready) {
            fail(new Error("desktop sidecar emitted duplicate ready message"));
            return;
          }
          this.ready = message;
          this.status = { state: "ready", port: message.port };
          if (!settled) {
            settled = true;
            resolve(this.getStatus());
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => {});
      child.once("error", (error) => fail(error));
      child.once("exit", (code, signal) => {
        this.child = null;
        if (!this.ready && !settled) {
          fail(new Error(`desktop sidecar exited before ready (code=${code ?? "null"}, signal=${signal ?? "none"})`));
        } else if (this.status.state === "ready") {
          this.status = { state: "stopped" };
        }
      });
    });
  }

  async stop(): Promise<BackendStatus> {
    const child = this.child;
    if (!child || child.killed) {
      this.status = { state: "stopped" };
      return this.status;
    }
    child.kill();
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.child = null;
    this.ready = null;
    this.status = { state: "stopped" };
    return this.status;
  }
}
