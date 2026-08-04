import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import path from "node:path";

type DesktopReadyMessage = {
  readonly type: "ready";
  readonly pid: number;
  readonly port: number;
  readonly hostname: "127.0.0.1";
  readonly version: string;
};

type DesktopStopRefusedMessage = {
  readonly type: "stop-refused";
  readonly error: string;
};

type DesktopStoppedMessage = {
  readonly type: "stopped";
};

export interface ExternalBackend {
  readonly pid?: number;
  readonly port: number;
}

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

function parseDesktopStopRefusedLine(line: string): DesktopStopRefusedMessage | null {
  try {
    const value: unknown = JSON.parse(line.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.type !== "stop-refused" || typeof candidate.error !== "string" || !candidate.error.trim()) return null;
    return { type: "stop-refused", error: candidate.error.trim() };
  } catch {
    return null;
  }
}

function parseDesktopStoppedLine(line: string): DesktopStoppedMessage | null {
  try {
    const value: unknown = JSON.parse(line.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return (value as Record<string, unknown>).type === "stopped" ? { type: "stopped" } : null;
  } catch {
    return null;
  }
}

function expandConfigHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(homedir(), raw.slice(2));
  return raw;
}

function desktopConfigDir(): string {
  const configured = process.env.OPENCODEX_HOME?.trim();
  return configured ? path.resolve(expandConfigHome(configured)) : path.join(homedir(), ".opencodex");
}

export function loopbackProbeHostname(hostname: unknown): "127.0.0.1" | null {
  const value = typeof hostname === "string" ? hostname.trim() : "";
  if (
    !value
    || value === "127.0.0.1"
    || value.toLowerCase() === "localhost"
    || value === "0.0.0.0"
    || value === "::"
    || value === "[::]"
  ) return "127.0.0.1";
  return null;
}

function readJsonRecord(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function probeExternalCandidate(candidate: Record<string, unknown>): Promise<ExternalBackend | null> {
  const port = Number(candidate.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const expectedPid = Number(candidate.pid);
  const hostname = loopbackProbeHostname(candidate.hostname);
  if (!hostname) return null;
  try {
    const response = await fetch(`http://${hostname}:${port}/healthz`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "opencodex") return null;
    const actualPid = Number(body.pid);
    if (Number.isInteger(expectedPid) && expectedPid > 0 && Number.isInteger(actualPid) && actualPid > 0 && actualPid !== expectedPid) {
      return null;
    }
    return {
      port,
      ...(Number.isInteger(actualPid) && actualPid > 0
        ? { pid: actualPid }
        : Number.isInteger(expectedPid) && expectedPid > 0 ? { pid: expectedPid } : {}),
    };
  } catch {
    return null;
  }
}

/** Read-only Electron-side liveness gate used before spawning the bundled Bun helper. */
export async function findExternalBackend(): Promise<ExternalBackend | null> {
  const dir = desktopConfigDir();
  const runtime = readJsonRecord(path.join(dir, "runtime-port.json"));
  if (runtime) {
    const live = await probeExternalCandidate(runtime);
    if (live) return live;
  }
  const config = readJsonRecord(path.join(dir, "config.json"));
  return probeExternalCandidate({
    port: config?.port ?? 10100,
    hostname: config?.hostname,
  });
}

export type BackendState = "not-started" | "starting" | "ready" | "stopped" | "failed";

export interface BackendStatus {
  readonly state: BackendState;
  readonly port?: number;
  readonly pid?: number;
  readonly ownership?: "desktop" | "external";
  readonly error?: string;
}

export type BackendStatusListener = (status: BackendStatus) => void;

export interface BackendSupervisorOptions {
  readonly cwd?: string;
  readonly bunExecutable?: string;
  readonly sidecarEntry?: string;
  readonly desktopVersion?: string;
  readonly desktopBuildRevision?: number;
  readonly findExternalBackend?: () => Promise<ExternalBackend | null>;
  readonly externalProbeIntervalMs?: number;
}

/**
 * Stage 1 deliberately contains no sidecar startup. The supervisor is the
 * single seam that later stages will use so the Electron host never grows a
 * second backend implementation.
 */
export class DesktopBackendSupervisor {
  private readonly options: BackendSupervisorOptions;
  private status: BackendStatus = { state: "not-started" };
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private ready: DesktopReadyMessage | null = null;
  private external: ExternalBackend | null = null;
  private externalMonitor: ReturnType<typeof setInterval> | null = null;
  private externalProbeRunning = false;
  private stopRefusalHandler: ((error: Error) => void) | null = null;
  private stopAcknowledged = false;
  private readonly listeners = new Set<BackendStatusListener>();

  constructor(options: BackendSupervisorOptions = {}) {
    this.options = options;
  }

  onStatusChange(listener: BackendStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: BackendStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
  }

  getStatus(): BackendStatus {
    return { ...this.status };
  }

  private clearExternalMonitor(): void {
    if (this.externalMonitor) clearInterval(this.externalMonitor);
    this.externalMonitor = null;
    this.externalProbeRunning = false;
  }

  private monitorExternalBackend(): void {
    this.clearExternalMonitor();
    let consecutiveFailures = 0;
    const finder = this.options.findExternalBackend ?? findExternalBackend;
    const check = async (): Promise<void> => {
      if (this.externalProbeRunning || !this.external) return;
      this.externalProbeRunning = true;
      try {
        const live = await finder();
        const sameOwner = live
          && live.port === this.external.port
          && (this.external.pid === undefined || live.pid === undefined || live.pid === this.external.pid);
        if (sameOwner) {
          consecutiveFailures = 0;
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures < 2) return;
        this.clearExternalMonitor();
        this.external = null;
        this.setStatus({ state: "failed", error: "external proxy is no longer healthy" });
      } finally {
        this.externalProbeRunning = false;
      }
    };
    this.externalMonitor = setInterval(() => void check(), this.options.externalProbeIntervalMs ?? 2_000);
    this.externalMonitor.unref?.();
  }

  async start(): Promise<BackendStatus> {
    if (this.child && !this.child.killed) return this.getStatus();
    if (this.external && this.status.state === "ready") return this.getStatus();

    this.clearExternalMonitor();
    this.setStatus({ state: "starting" });
    this.ready = null;
    this.stopAcknowledged = false;
    this.external = null;
    const finder = this.options.findExternalBackend ?? findExternalBackend;
    const external = await finder().catch(() => null);
    if (external) {
      this.external = external;
      this.setStatus({ state: "ready", port: external.port, pid: external.pid, ownership: "external" });
      this.monitorExternalBackend();
      return this.getStatus();
    }

    const cwd = this.options.cwd ?? process.cwd();
    const bunExecutable = process.env.OPENCODEX_BUN_EXECUTABLE
      ?? this.options.bunExecutable
      ?? "bun";
    const entry = process.env.OPENCODEX_DESKTOP_SIDECAR
      ?? this.options.sidecarEntry
      ?? path.resolve(cwd, "src/desktop/entry.ts");
    const child = spawn(bunExecutable, [entry], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODEX_DESKTOP: "1",
        OPENCODEX_DESKTOP_MODE: "1",
        ...(this.options.desktopVersion ? { OPENCODEX_DESKTOP_VERSION: this.options.desktopVersion } : {}),
        OPENCODEX_DESKTOP_BUILD_REVISION: String(this.options.desktopBuildRevision ?? 0),
      },
    });
    this.child = child;

    return await new Promise<BackendStatus>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      const fail = (error: Error): void => {
        this.setStatus({ state: "failed", error: error.message });
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
          if (parseDesktopStoppedLine(line)) {
            this.stopAcknowledged = true;
            continue;
          }
          const refusal = parseDesktopStopRefusedLine(line);
          if (refusal) {
            this.stopRefusalHandler?.(new Error(refusal.error));
            continue;
          }
          const message = parseDesktopReadyLine(line);
          if (!message) continue;
          if (this.ready) {
            fail(new Error("desktop sidecar emitted duplicate ready message"));
            return;
          }
          this.ready = message;
          this.setStatus({ state: "ready", port: message.port, pid: message.pid, ownership: "desktop" });
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
          this.ready = null;
          this.setStatus({ state: "stopped" });
        }
      });
    });
  }

  async stop(): Promise<BackendStatus> {
    this.clearExternalMonitor();
    if (this.external) {
      this.external = null;
      this.ready = null;
      this.setStatus({ state: "stopped" });
      return this.status;
    }
    const child = this.child;
    if (!child || child.killed) {
      this.setStatus({ state: "stopped" });
      return this.status;
    }
    try {
      child.stdin.write("stop\n");
    } catch {
      throw new Error("desktop sidecar stop request could not be delivered; proxy was left running");
    }
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timeout);
        this.stopRefusalHandler = null;
        if (this.stopAcknowledged && code === 0 && signal === null) {
          resolve();
          return;
        }
        const error = new Error(
          `desktop sidecar exited without a successful stop acknowledgement (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        );
        this.setStatus({ state: "failed", error: error.message });
        reject(error);
      };
      const timeout = setTimeout(() => {
        child.off("exit", onExit);
        this.stopRefusalHandler = null;
        reject(new Error("desktop sidecar did not acknowledge stop; proxy was left running"));
      }, 5_000);
      this.stopRefusalHandler = error => {
        clearTimeout(timeout);
        child.off("exit", onExit);
        this.stopRefusalHandler = null;
        reject(error);
      };
      child.once("exit", onExit);
    });
    this.child = null;
    this.ready = null;
    this.stopAcknowledged = false;
    this.setStatus({ state: "stopped" });
    return this.status;
  }
}
