import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function windowsRundll32(): string {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidate = join(windowsRoot, "System32", "rundll32.exe");
  return existsSync(candidate) ? candidate : "rundll32";
}

export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? windowsRundll32()
    : "xdg-open";
  const args = process.platform === "win32"
    ? ["url.dll,FileProtocolHandler", url]
    : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore", shell: false }).unref();
}
