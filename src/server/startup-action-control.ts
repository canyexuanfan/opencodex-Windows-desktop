import { execFile } from "node:child_process";
import { join } from "node:path";
import { durableBunPath } from "../lib/bun-runtime";

export type StartupInstallAction = "install-service" | "install-shim";
let activeInstall: StartupInstallAction | null = null;

export function startupInstallArgv(action: StartupInstallAction): string[] {
  return action === "install-service"
    ? ["service", "install"]
    : ["codex-shim", "install"];
}

/** Execute the existing fixed CLI installer outside the proxy event loop. */
export function runStartupInstallAction(action: StartupInstallAction): Promise<{ message: string }> {
  if (activeInstall) return Promise.reject(new Error(`Another startup installation is already running: ${activeInstall}`));
  activeInstall = action;
  const bun = durableBunPath();
  const cli = join(import.meta.dir, "..", "cli", "index.ts");
  const operation = new Promise<{ message: string }>((resolve, reject) => {
    execFile(bun, [cli, ...startupInstallArgv(action)], {
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(detail.slice(0, 2_000)));
        return;
      }
      resolve({
        message: action === "install-service"
          ? "Background service installed."
          : "Codex launcher shim installed.",
      });
    });
  });
  return operation.finally(() => { activeInstall = null; });
}
