import { spawn } from "node:child_process";

export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "rundll32"
    : "xdg-open";
  const args = process.platform === "win32"
    ? ["url.dll,FileProtocolHandler", url]
    : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore", shell: false }).unref();
}
