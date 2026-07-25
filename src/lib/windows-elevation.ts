import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type ElevationSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

let elevationSpawn: ElevationSpawn = spawn;

/** Test-only seam for the elevated PowerShell launcher. */
export function setWindowsElevationSpawnForTests(next: ElevationSpawn | null): void {
  elevationSpawn = next ?? spawn;
}

/** Stable machine-readable marker for a denied `schtasks /create`. Crosses the CLI→proxy boundary. */
export const WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER =
  "OCX_ERROR_CODE=WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED";

export type WindowsSchtasksOperation = "create" | "run" | "query" | "delete" | "end" | "other";
export type WindowsSchtasksFailureReason = "access-denied" | "other";

export type WindowsElevationFailureReason =
  | "cancelled"
  | "timeout"
  | "launch-failed"
  | "child-failed"
  | "terminated";

const ELEVATION_OUTPUT_LIMIT = 256 * 1024;

function windowsAccessDeniedText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("access denied")
    || normalized.includes("access is denied")
    || normalized.includes("denied access")
    || normalized.includes("zugriff verweigert");
}

function windowsUacCancelledText(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("operation was canceled by the user")
    || normalized.includes("operation was cancelled by the user")
    || normalized.includes("the operation was canceled")
    || normalized.includes("the operation was cancelled")
    || normalized.includes("vom benutzer abgebrochen")
    || normalized.includes("durch den benutzer abgebrochen");
}

/** True when a captured stderr/stdout/message indicates Windows access denial. */
export function isWindowsAccessDenied(detail: string): boolean {
  return windowsAccessDeniedText(detail);
}

/** True when a thrown exec error looks like Windows access denial. */
export function isWindowsAccessDeniedError(error: unknown): boolean {
  if (error instanceof WindowsSchtasksError) return error.reason === "access-denied";
  if (!(error instanceof Error)) return isWindowsAccessDenied(String(error));
  const exec = error as NodeJS.ErrnoException & { stderr?: string | Buffer; stdout?: string | Buffer };
  const parts = [error.message, exec.stderr, exec.stdout]
    .map(part => (typeof part === "string" ? part : part ? String(part) : ""));
  return parts.some(part => windowsAccessDeniedText(part));
}

/** True only for a structured Task Scheduler `/create` access-denied failure. */
export function isWindowsSchtasksCreateAccessDenied(detail: string): boolean {
  return detail.includes(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
}

export function schtasksOperationFromArgs(args: string[]): WindowsSchtasksOperation {
  const flag = (args[0] ?? "").toLowerCase();
  if (flag === "/create") return "create";
  if (flag === "/run") return "run";
  if (flag === "/query") return "query";
  if (flag === "/delete") return "delete";
  if (flag === "/end") return "end";
  return "other";
}

/** Structured Task Scheduler failure that survives formatting and process boundaries. */
export class WindowsSchtasksError extends Error {
  readonly code = "WINDOWS_SCHTASKS_ERROR" as const;

  constructor(
    readonly operation: WindowsSchtasksOperation,
    readonly reason: WindowsSchtasksFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "WindowsSchtasksError";
  }

  get machineMarker(): string | null {
    return this.operation === "create" && this.reason === "access-denied"
      ? WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER
      : null;
  }
}

export class WindowsElevationError extends Error {
  readonly code = "WINDOWS_ELEVATION_ERROR" as const;

  constructor(
    readonly reason: WindowsElevationFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "WindowsElevationError";
  }
}

/** Replace raw schtasks access-denied output with dashboard-friendly guidance. */
export function formatWindowsSchtasksError(error: unknown, args: string[]): string {
  const operation = schtasksOperationFromArgs(args);
  const accessDenied = isWindowsAccessDeniedError(error);
  if (!accessDenied) {
    return error instanceof Error ? error.message : String(error);
  }
  const argsText = args.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  const guidance = [
    "Windows access denied while running Task Scheduler.",
    `Command: schtasks ${argsText}`,
    "Approve the Windows UAC prompt to install the background service, or run `ocx service install` from an elevated PowerShell window.",
  ].join(" ");
  if (operation === "create") {
    return `${guidance}\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`;
  }
  return guidance;
}

export function toWindowsSchtasksError(error: unknown, args: string[]): WindowsSchtasksError {
  if (error instanceof WindowsSchtasksError) return error;
  const operation = schtasksOperationFromArgs(args);
  const reason: WindowsSchtasksFailureReason = isWindowsAccessDeniedError(error) ? "access-denied" : "other";
  return new WindowsSchtasksError(operation, reason, formatWindowsSchtasksError(error, args));
}

/**
 * Quote one argument for Win32 CommandLineToArgvW / Start-Process -ArgumentList.
 * Handles empty args, spaces, embedded quotes, and trailing backslashes.
 */
export function windowsCmdQuote(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  let result = '"';
  let numBackslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      numBackslashes += 1;
      continue;
    }
    if (ch === '"') {
      result += "\\".repeat(numBackslashes * 2 + 1) + '"';
      numBackslashes = 0;
      continue;
    }
    result += "\\".repeat(numBackslashes) + ch;
    numBackslashes = 0;
  }
  result += "\\".repeat(numBackslashes * 2) + '"';
  return result;
}

/** Build one Win32 argument-list string for Start-Process -ArgumentList. */
export function buildWindowsElevatedArgumentList(args: string[]): string {
  return args.map(windowsCmdQuote).join(" ");
}

function windowsPowerShell(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : "powershell.exe";
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function appendBounded(current: string, chunk: string, limit = ELEVATION_OUTPUT_LIMIT): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  return current + chunk.slice(0, remaining);
}

export interface WindowsElevationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Launch a file with UAC elevation and wait for it to exit.
 * Throws WindowsElevationError for cancellation, timeout, launch failure, or signal termination.
 * Returns the elevated process exit code for completed launches (including non-zero).
 */
export function runWindowsElevated(file: string, args: string[], timeoutMs = 120_000): Promise<number> {
  if (process.platform !== "win32") {
    return Promise.reject(new WindowsElevationError(
      "launch-failed",
      "Windows elevation is only supported on Windows.",
    ));
  }
  const argumentList = buildWindowsElevatedArgumentList(args);
  const script = [
    `$p = Start-Process -FilePath ${psSingleQuote(file)}`,
    argumentList.length > 0 ? ` -ArgumentList ${psSingleQuote(argumentList)}` : "",
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    "if ($null -eq $p) { exit 1223 }",
    "exit $p.ExitCode",
  ].join("");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    try {
      child = elevationSpawn(
        windowsPowerShell(),
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      reject(new WindowsElevationError(
        "launch-failed",
        error instanceof Error ? error.message : String(error),
      ));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
      // The elevated child started by Start-Process -Verb RunAs may outlive this launcher.
      settle(() => reject(new WindowsElevationError(
        "timeout",
        `Windows elevation timed out after ${timeoutMs}ms. The elevated Task Scheduler process may still be running.`,
      )));
    }, timeoutMs);

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout = appendBounded(stdout, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr = appendBounded(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(() => reject(new WindowsElevationError(
        "launch-failed",
        error.code === "ENOENT"
          ? "Windows PowerShell was not found for elevation."
          : (error.message || "Windows elevation failed to launch."),
      )));
    });

    child.once("close", (code, signal) => {
      if (timedOut) return;
      const detail = stderr.trim() || stdout.trim();
      if (typeof code === "number") {
        if (code === 1223 || windowsUacCancelledText(detail)) {
          settle(() => reject(new WindowsElevationError(
            "cancelled",
            "Windows administrator approval was required, but the UAC prompt was cancelled or denied.",
          )));
          return;
        }
        settle(() => resolve(code));
        return;
      }
      settle(() => reject(new WindowsElevationError(
        "terminated",
        `Windows elevation terminated by ${signal ?? "unknown signal"}.`,
      )));
    });
  });
}
