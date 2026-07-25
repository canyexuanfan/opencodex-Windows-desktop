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

type FinalizeFn = typeof finalizeWindowsSchedulerServiceRegistration;
let finalizeImpl: FinalizeFn = finalizeWindowsSchedulerServiceRegistration;

/** Test-only seam so elevation retry tests do not mock.module the service package. */
export function setStartupInstallFinalizeForTests(next: FinalizeFn | null): void {
  finalizeImpl = next ?? finalizeWindowsSchedulerServiceRegistration;
}

export function startupInstallArgv(action: StartupInstallAction): string[] {
  return action === "install-service"
    ? ["service", "install"]
    : ["codex-shim", "install"];
}

export interface CliInstallFailure {
  /** Machine marker such as OCX_ERROR_CODE=..., when present in any stream. */
  code: string | null;
  stdout: string;
  stderr: string;
  message: string;
  /** Bounded user-facing diagnostic (may append the marker if truncated away). */
  detail: string;
}

function extractOcxErrorCode(text: string): string | null {
  const match = text.match(/OCX_ERROR_CODE=[A-Z0-9_]+/);
  return match ? match[0] : null;
}

/**
 * Classify a CLI install failure, keeping the machine marker separate from the
 * truncated user-facing diagnostic.
 */
export function classifyCliInstallFailure(stdout: string, stderr: string, error: Error): CliInstallFailure {
  const stdoutText = stdout.trim();
  const stderrText = stderr.trim();
  const message = error.message.trim();
  const combined = [stderrText, stdoutText, message].filter(Boolean).join("\n");
  const code = extractOcxErrorCode(combined);
  let detail = combined || message;
  if (detail.length > INSTALL_DETAIL_LIMIT) {
    const truncated = detail.slice(0, INSTALL_DETAIL_LIMIT);
    detail = code && !truncated.includes(code)
      ? `${truncated}\n${code}… (truncated)`
      : `${truncated}… (truncated)`;
  }
  return { code, stdout: stdoutText, stderr: stderrText, message, detail };
}

/** @deprecated Prefer classifyCliInstallFailure; kept for existing tests. */
export function installFailureDetail(stdout: string, stderr: string, error: Error): string {
  return classifyCliInstallFailure(stdout, stderr, error).detail;
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
        const failure = classifyCliInstallFailure(stdout, stderr, error);
        reject(Object.assign(new Error(failure.detail), { ocxInstallFailure: failure }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function installFailureCode(error: unknown): string | null {
  if (error && typeof error === "object" && "ocxInstallFailure" in error) {
    const failure = (error as { ocxInstallFailure?: CliInstallFailure }).ocxInstallFailure;
    if (failure?.code) return failure.code;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return extractOcxErrorCode(detail);
}

/** Execute the existing fixed CLI installer outside the proxy event loop. */
export function runStartupInstallAction(action: StartupInstallAction): Promise<{ message: string }> {
  if (activeInstall) return Promise.reject(new Error(`Another startup installation is already running: ${activeInstall}`));
  activeInstall = action;
  const operation = (async () => {
    try {
      await runCliInstall(action);
    } catch (error) {
      const code = installFailureCode(error);
      const detail = error instanceof Error ? error.message : String(error);
      // Elevate only for a structured Task Scheduler /create access denial — never for
      // WinSW removal, asset writes, or generic permission errors.
      if (
        action === "install-service"
        && process.platform === "win32"
        && (code === WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER
          || isWindowsSchtasksCreateAccessDenied(detail))
      ) {
        await finalizeImpl();
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
