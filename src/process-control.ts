import { execFileSync } from "node:child_process";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const marker = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(marker, 0, 0, 50);
  }
  return !isProcessAlive(pid);
}

export function killProxy(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try {
      execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } catch (err) {
      if (isProcessAlive(pid)) throw err;
    }
  } else {
    process.kill(pid, "SIGTERM");
    if (!waitForExit(pid, 5000)) process.kill(pid, "SIGKILL");
  }
  if (!waitForExit(pid, 5000)) throw new Error(`process ${pid} did not exit`);
}
