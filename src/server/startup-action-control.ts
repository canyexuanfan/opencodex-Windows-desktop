import { execFile } from "node:child_process";
import { join } from "node:path";
import { durableBunPath } from "../lib/bun-runtime";
import {
  WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
  isWindowsSchtasksCreateAccessDenied,
} from "../lib/windows-elevation";
import { finalizeWindowsSchedulerServiceRegistration } from "../service";

export type StartupInstallAction = "install-service" | "install-shim";
let activeInstall: StartupInstallAction | null = null;

const INSTALL_DETAIL_LIMIT = 2_000;

export function startupInstallArgv(action: StartupInstallAction): string[] {
  return action === "install-service"
    ? ["service", "install"]
    : ["codex-shim", "install"];
}

/**
 * Build the CLI failure text used for dashboard errors and elevation detection.
 * Combines stderr and stdout so a retry marker on either stream is preserved,
 * and caps length so API responses stay bounded.
 */
export function installFailureDetail(stdout: string, stderr: string, error: Error): string {
  const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  const detail = combined || error.message;
  if (detail.length <= INSTALL_DETAIL_LIMIT) return detail;
  const truncated = detail.slice(0, INSTALL_DETAIL_LIMIT);
  // Keep the structured elevation marker even when truncating a large dump.
  if (
    detail.includes(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER)
    && !truncated.includes(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER)
  ) {
    return `${truncated}\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}… (truncated)`;
  }
  return `${truncated}… (truncated)`;
}

function runCliInstall(action: StartupInstallAction): Promise<{ stdout: string; stderr: string }> {
  const bun = durableBunPath();
  const cli = join(import.meta.dir, "..", "cli", "index.ts");
  const argv = [cli, ...startupInstallArgv(action)];
  return new Promise((resolve, reject) => {
    execFile(bun, argv, {
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(installFailureDetail(stdout, stderr, error)));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Execute the existing fixed CLI installer outside the proxy event loop. */
export function runStartupInstallAction(action: StartupInstallAction): Promise<{ message: string }> {
  if (activeInstall) return Promise.reject(new Error(`Another startup installation is already running: ${activeInstall}`));
  activeInstall = action;
  const operation = (async () => {
    try {
      await runCliInstall(action);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Elevate only for a structured Task Scheduler /create access denial — never for
      // WinSW removal, asset writes, or generic permission errors.
      // finalizeWindowsSchedulerServiceRegistration verifies conflict-free state, rolls
      // back on failure, and writes install state only after checks pass.
      if (
        action === "install-service"
        && process.platform === "win32"
        && isWindowsSchtasksCreateAccessDenied(detail)
      ) {
        await finalizeWindowsSchedulerServiceRegistration();
      } else {
        throw error;
      }
    }
    return {
      message: action === "install-service"
        ? "Background service installed."
        : "Codex launcher shim installed.",
    };
  })();
  return operation.finally(() => { activeInstall = null; });
}
