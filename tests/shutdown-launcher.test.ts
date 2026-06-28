import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: `ocx start` + Ctrl-C must NOT orphan the Bun proxy.
 *
 * The bin/ocx.mjs launcher used a blocking spawnSync that did not forward signals,
 * so a signal delivered only to the launcher killed it and left the Bun child
 * serving forever (port bound, ocx.pid/runtime-port.json left behind, Codex config
 * not restored). The launcher now forwards SIGINT/SIGTERM/SIGHUP to the child and
 * waits for its graceful shutdown.
 *
 * POSIX-only (Windows has no real signal forwarding semantics) and requires `node`
 * on PATH to exercise the real launcher.
 */

const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
const nodeAvailable = !spawnSync("node", ["--version"], { stdio: "ignore" }).error;
const runnable = process.platform !== "win32" && nodeAvailable;

const spawned: ChildProcess[] = [];
const tmpHomes: string[] = [];

afterAll(() => {
  for (const c of spawned) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of tmpHomes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(fn: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(250);
  }
  return false;
}

describe.skipIf(!runnable)("ocx launcher graceful shutdown", () => {
  test(
    "SIGINT to the launcher tears down the Bun proxy (no orphan)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "ocx-shutdown-"));
      tmpHomes.push(home);
      const port = await freePort();

      const child = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
        stdio: "ignore",
        env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home },
      });
      spawned.push(child);

      let exited = false;
      let exitSignal: NodeJS.Signals | null = null;
      child.on("exit", (_code, signal) => {
        exited = true;
        exitSignal = signal;
      });

      // 1. Proxy comes up.
      const up = await waitUntil(() => healthy(port), 20_000);
      expect(up).toBe(true);
      expect(existsSync(join(home, "ocx.pid"))).toBe(true);

      // 2. Signal ONLY the launcher PID (the exact orphan trigger).
      child.kill("SIGINT");

      // 3. Launcher exits...
      const launcherGone = await waitUntil(async () => exited, 15_000);
      expect(launcherGone).toBe(true);

      // 4. ...and the Bun proxy is gone (port freed) — the regression guard.
      const portFreed = await waitUntil(async () => !(await healthy(port)), 10_000);
      expect(portFreed).toBe(true);

      // 5. Cleanup ran: pid + runtime-port files removed.
      expect(existsSync(join(home, "ocx.pid"))).toBe(false);
      expect(existsSync(join(home, "runtime-port.json"))).toBe(false);

      void exitSignal; // captured for debugging; assertion is on teardown, not signal identity
    },
    45_000,
  );
});
