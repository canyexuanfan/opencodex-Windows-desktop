/**
 * Reclaim a listen port after stop/update so restart can stay on the configured
 * port instead of hopping to an ephemeral one (Windows CLOSE_WAIT / leftover ocx).
 */
import { execFileSync } from "node:child_process";
import { verifyPidIdentity } from "../config";
import { isProcessAlive, killProxy } from "../lib/process-control";
import { isPortAvailable, type WaitForPortOptions } from "./ports";
import { dropWindowsTcpRowsForLocalPort } from "./windows-tcp-drop";

export type ReclaimListenPortOptions = WaitForPortOptions & {
  /** Kill leftover ocx-start listeners found on the port while waiting. Default true. */
  killOcxHolders?: boolean;
  /**
   * On Windows, force-delete TCP rows for this local port (RST clients / ghost LISTEN)
   * via SetTcpEntry. Default true on win32. Never kills foreign processes.
   */
  dropTcpRows?: boolean;
  /** How often to scan for listen PIDs / attempt TCB drop (ms). Default 500. */
  scanIntervalMs?: number;
  listListenPidsFn?: (port: number) => number[];
  isAliveFn?: (pid: number) => boolean;
  verifyOcxFn?: (pid: number) => number | null;
  killFn?: (pid: number) => void;
  dropTcpFn?: (port: number) => number;
  isAvailableFn?: (port: number, hostname?: string) => Promise<boolean>;
  sleepMs?: (ms: number) => Promise<void>;
};

/**
 * Parse `netstat -ano` (Windows) / `netstat -anlp` listen lines for a port.
 * Exported for unit tests.
 */
export function parseListenPidsFromNetstat(output: string, port: number): number[] {
  const pids = new Set<number>();
  const portSuffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^TCP\b/i.test(line) && !/^tcp\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    // Prefer the first address token that ends with :port (local), not a later foreign one.
    const localIdx = parts.findIndex(part => part.endsWith(portSuffix) || part.endsWith(`]:${port}`));
    if (localIdx < 0) continue;
    const foreign = parts[localIdx + 1] ?? "";
    // Locale-safe listen detection: English LISTEN*, or unbound foreign wildcard
    // (German ABHÖREN still shows 0.0.0.0:0 / *:*).
    const listenWord = /\bLISTEN/i.test(line);
    const wildcardForeign = /^(0\.0\.0\.0|::|\*|\[::\]):0$/.test(foreign) || foreign === "*:*";
    if (!listenWord && !wildcardForeign) continue;
    const last = parts[parts.length - 1] ?? "";
    const winPid = /^\d+$/.test(last) ? Number(last) : NaN;
    const unixPid = /^(\d+)(?:\/\S*)?$/.exec(last);
    const pid = Number.isSafeInteger(winPid) && winPid > 0
      ? winPid
      : unixPid
        ? Number(unixPid[1])
        : NaN;
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Best-effort PIDs currently LISTENing on `port`. Empty on probe failure. */
export function listListenPids(port: number): number[] {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return [];
  try {
    if (process.platform === "win32") {
      return parseListenPidsFromNetstat(readWindowsNetstatAno(), port);
    }
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return output
        .split(/\r?\n/)
        .map(line => Number(line.trim()))
        .filter(pid => Number.isSafeInteger(pid) && pid > 0);
    } catch {
      const output = execFileSync("netstat", ["-anlp"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      });
      return parseListenPidsFromNetstat(output, Math.trunc(port));
    }
  } catch {
    return [];
  }
}

/** Prefer English netstat states; fall back to the UI-locale table. */
function readWindowsNetstatAno(): string {
  const netstat = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\netstat.exe`;
  const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  try {
    // chcp 437 forces English LISTENING/ESTABLISHED labels on localized Windows.
    return execFileSync(cmd, ["/d", "/c", `chcp 437>nul & "${netstat}" -ano -p tcp`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return execFileSync(netstat, ["-ano", "-p", "tcp"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      windowsHide: true,
    });
  }
}

/**
 * Wait until `port` can bind. While waiting:
 * - kill leftover *opencodex start* processes still holding the listen socket
 * - on Windows, best-effort RST of TCP rows on that local port (clients / ghost LISTEN)
 * Never kills foreign processes (browsers stay up; their sockets to the dead proxy are reset).
 */
export async function reclaimListenPort(
  port: number,
  hostname = "127.0.0.1",
  opts: ReclaimListenPortOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 100;
  const scanIntervalMs = opts.scanIntervalMs ?? 500;
  const killOcxHolders = opts.killOcxHolders !== false;
  const dropTcpRows = opts.dropTcpRows ?? process.platform === "win32";
  const listFn = opts.listListenPidsFn ?? listListenPids;
  const isAliveFn = opts.isAliveFn ?? isProcessAlive;
  const verifyOcxFn = opts.verifyOcxFn ?? verifyPidIdentity;
  const killFn = opts.killFn ?? killProxy;
  const dropTcpFn = opts.dropTcpFn ?? dropWindowsTcpRowsForLocalPort;
  const isAvailableFn = opts.isAvailableFn ?? isPortAvailable;
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const deadline = Date.now() + timeoutMs;
  let lastScan = 0;
  const killed = new Set<number>();

  for (;;) {
    if (await isAvailableFn(port, hostname)) return true;
    if (Date.now() >= deadline) return false;

    if (Date.now() - lastScan >= scanIntervalMs) {
      lastScan = Date.now();

      if (killOcxHolders) {
        for (const pid of listFn(port)) {
          if (killed.has(pid) || pid === process.pid) continue;
          if (!isAliveFn(pid)) continue; // Windows may still list a dead owner briefly
          if (verifyOcxFn(pid) !== pid) continue;
          try {
            killFn(pid);
            killed.add(pid);
          } catch {
            /* keep waiting; next scan retries */
          }
        }
      }

      // After hard-kill, browsers often keep ESTABLISHED/CLOSE_WAIT to the dead listener.
      // Reset those TCBs (and ghost LISTEN rows) so the configured port can bind again —
      // without killing the browser process.
      if (dropTcpRows) {
        try {
          dropTcpFn(port);
        } catch {
          /* access denied / unsupported — keep waiting */
        }
      }
    }

    await sleep(intervalMs);
  }
}
