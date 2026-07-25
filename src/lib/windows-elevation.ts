import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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

export const OCX_SCHTASKS_CREATE_EXIT_PREFIX = "OCX_SCHTASKS_CREATE_EXIT=";
export const OCX_SCHTASKS_RUN_EXIT_PREFIX = "OCX_SCHTASKS_RUN_EXIT=";

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

function parsePrefixedExit(output: string, prefix: string): number | null {
  const match = output.match(new RegExp(`${prefix}(-?\\d+)`, "m"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Spawn non-elevated PowerShell to run a -Command script; classify UAC/cancel/timeout outcomes. */
function runPowerShellCommand(commandScript: string, timeoutMs: number): Promise<WindowsElevationResult> {
  if (process.platform !== "win32") {
    return Promise.reject(new WindowsElevationError(
      "launch-failed",
      "Windows elevation is only supported on Windows.",
    ));
  }

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
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", commandScript],
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
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      if (typeof code === "number") {
        if (code === 1223 || windowsUacCancelledText(detail)) {
          settle(() => reject(new WindowsElevationError(
            "cancelled",
            "Windows administrator approval was required, but the UAC prompt was cancelled or denied.",
          )));
          return;
        }
        settle(() => resolve({ exitCode: code, stdout, stderr }));
        return;
      }
      settle(() => reject(new WindowsElevationError(
        "terminated",
        `Windows elevation terminated by ${signal ?? "unknown signal"}.`,
      )));
    });
  });
}

/**
 * Launch a file with UAC elevation and wait for it to exit.
 * Throws WindowsElevationError for cancellation, timeout, launch failure, or signal termination.
 * Returns the elevated process exit code for completed launches (including non-zero).
 */
export function runWindowsElevated(file: string, args: string[], timeoutMs = 120_000): Promise<number> {
  const argumentList = buildWindowsElevatedArgumentList(args);
  // Touch .Handle so Windows PowerShell 5.1 keeps a process handle; ExitCode can
  // otherwise stay $null after -Wait and `exit $null` becomes exit 0 (false success).
  const script = [
    `$p = Start-Process -FilePath ${psSingleQuote(file)}`,
    argumentList.length > 0 ? ` -ArgumentList ${psSingleQuote(argumentList)}` : "",
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    "if ($null -eq $p) { exit 1223 }",
    "$null = $p.Handle",
    "if ($null -eq $p.ExitCode) { exit 1 }",
    "exit $p.ExitCode",
  ].join("");

  return runPowerShellCommand(script, timeoutMs).then(result => result.exitCode);
}

export interface ElevatedSchtasksCreateAndRunResult {
  createExitCode: number;
  /** null when /run was not attempted because /create failed. */
  runExitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Build the elevated (post-UAC) script that runs schtasks /create then /run without a second prompt. */
export function buildElevatedSchtasksCreateAndRunScript(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  resultPath: string,
): string {
  const createList = buildWindowsElevatedArgumentList(createArgs);
  const runList = buildWindowsElevatedArgumentList(runArgs);
  const createPrefix = OCX_SCHTASKS_CREATE_EXIT_PREFIX;
  const runPrefix = OCX_SCHTASKS_RUN_EXIT_PREFIX;
  return [
    `$schtasks = ${psSingleQuote(schtasksPath)}`,
    `$resultPath = ${psSingleQuote(resultPath)}`,
    "function Invoke-OcxSchtasks([string]$ArgList) {",
    "  $p = Start-Process -FilePath $schtasks -ArgumentList $ArgList -Wait -PassThru -WindowStyle Hidden",
    "  if ($null -eq $p) { return 1 }",
    "  $null = $p.Handle",
    "  if ($null -eq $p.ExitCode) { return 1 }",
    "  return [int]$p.ExitCode",
    "}",
    "function Write-OcxResult([int]$CreateCode, $RunCode) {",
    `  $lines = @('${createPrefix}' + $CreateCode)`,
    `  if ($null -ne $RunCode) { $lines += ('${runPrefix}' + $RunCode) }`,
    "  Set-Content -LiteralPath $resultPath -Value ($lines -join [Environment]::NewLine) -Encoding ascii",
    "}",
    `$createCode = Invoke-OcxSchtasks ${psSingleQuote(createList)}`,
    "if ($createCode -ne 0) { Write-OcxResult $createCode $null; exit $createCode }",
    `$runCode = Invoke-OcxSchtasks ${psSingleQuote(runList)}`,
    "Write-OcxResult $createCode $runCode",
    "exit $runCode",
  ].join("; ");
}

function readElevatedResultFile(resultPath: string): string {
  try {
    if (!existsSync(resultPath)) return "";
    return readFileSync(resultPath, "utf8");
  } catch {
    return "";
  } finally {
    try { if (existsSync(resultPath)) unlinkSync(resultPath); } catch { /* ignore */ }
  }
}

/**
 * Create and run the scheduler task inside one elevated PowerShell process (one UAC prompt).
 * Throws WindowsElevationError for UAC cancel/timeout/launch/signal failures.
 */
export async function runElevatedSchtasksCreateAndRun(
  schtasksPath: string,
  createArgs: string[],
  runArgs: string[],
  timeoutMs = 120_000,
): Promise<ElevatedSchtasksCreateAndRunResult> {
  const resultPath = join(tmpdir(), `ocx-elev-schtasks-${randomBytes(8).toString("hex")}.txt`);
  const inner = buildElevatedSchtasksCreateAndRunScript(schtasksPath, createArgs, runArgs, resultPath);
  // One Start-Process -Verb RunAs elevates PowerShell; create and run execute inside that process.
  const launcher = [
    `$p = Start-Process -FilePath ${psSingleQuote(windowsPowerShell())}`,
    ` -ArgumentList ${psSingleQuote(buildWindowsElevatedArgumentList([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      inner,
    ]))}`,
    " -Verb RunAs -WindowStyle Hidden -PassThru -Wait;",
    "if ($null -eq $p) { exit 1223 }",
    "$null = $p.Handle",
    "if ($null -eq $p.ExitCode) { exit 1 }",
    "exit $p.ExitCode",
  ].join("");

  try {
    const result = await runPowerShellCommand(launcher, timeoutMs);
    const markerText = readElevatedResultFile(resultPath);
    const combined = `${markerText}\n${result.stdout}\n${result.stderr}`;
    const createExitCode = parsePrefixedExit(combined, OCX_SCHTASKS_CREATE_EXIT_PREFIX) ?? result.exitCode;
    const runExitCode = createExitCode === 0
      ? (parsePrefixedExit(combined, OCX_SCHTASKS_RUN_EXIT_PREFIX) ?? result.exitCode)
      : null;
    return {
      createExitCode,
      runExitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    readElevatedResultFile(resultPath);
    throw error;
  }
}
