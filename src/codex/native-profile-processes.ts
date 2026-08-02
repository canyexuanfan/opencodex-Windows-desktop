import { execFileSync } from "node:child_process";
import { basename, win32 } from "node:path";

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const PROCESS_LIST_MAX_BUFFER = 16 * 1024 * 1024;

export interface NativeProcessExecOptions {
  encoding: "utf8";
  stdio: ["ignore", "pipe", "ignore"];
  timeout: number;
  maxBuffer: number;
  windowsHide?: boolean;
}

export type NativeProcessExecutor = (file: string, args: string[], options: NativeProcessExecOptions) => string;

export interface NativeCodexProcessProbeOptions {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  execFile?: NativeProcessExecutor;
  pid?: number;
}

export type NativeCodexProcessProbe =
  | { status: "clear"; count: 0 }
  | { status: "busy"; count: number }
  | { status: "unknown"; count: 0 };

const executeProcess: NativeProcessExecutor = (file, args, options) => execFileSync(file, args, options);

export function resolveWindowsSystemRoot(value: string | undefined): string {
  if (!value?.trim()) return DEFAULT_WINDOWS_SYSTEM_ROOT;
  const normalized = win32.normalize(value.trim());
  const parsed = win32.parse(normalized);
  const driveRoot = /^[A-Za-z]:\\$/.test(parsed.root);
  const directWindowsDirectory = win32.dirname(normalized).toLowerCase() === parsed.root.toLowerCase()
    && win32.basename(normalized).toLowerCase() === "windows";
  return driveRoot && directWindowsDirectory
    ? `${parsed.root[0]!.toUpperCase()}:\\Windows`
    : DEFAULT_WINDOWS_SYSTEM_ROOT;
}

function windowsProcessCount(execFile: NativeProcessExecutor, systemRoot: string | undefined): number {
  const powershell = win32.join(
    resolveWindowsSystemRoot(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference='Stop';",
    "$self=$PID;",
    "$items=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and ($_.Name -match '^(?i:codex)(?:\\.exe)?$' -or $_.CommandLine -match '(?i)(?:^|[\\\\/\"\\s])codex(?:\\.exe|\\.cmd)?(?:[\"\\s]|$)') };",
    "@($items).Count",
  ].join(" ");
  const output = execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 12_000,
    maxBuffer: PROCESS_LIST_MAX_BUFFER,
    windowsHide: true,
  }).trim();
  const count = Number(output);
  if (!Number.isInteger(count) || count < 0) throw new Error("invalid process count");
  return count;
}

function unixProcessCount(execFile: NativeProcessExecutor, pid: number): number {
  const output = execFile("ps", ["-eo", "pid=,comm=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    maxBuffer: PROCESS_LIST_MAX_BUFFER,
  });
  let count = 0;
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match || Number(match[1]) === pid) continue;
    const command = basename(match[2]!).toLowerCase();
    const firstArg = basename(match[3]!.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
    if (command === "codex" || command === "codex.exe" || firstArg === "codex" || firstArg === "codex.exe") count += 1;
  }
  return count;
}

/** Best-effort, read-only process probe. It never terminates a user process. */
export async function probeNativeCodexProcesses({
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  execFile = executeProcess,
  pid = process.pid,
}: NativeCodexProcessProbeOptions = {}): Promise<NativeCodexProcessProbe> {
  try {
    const count = platform === "win32"
      ? windowsProcessCount(execFile, systemRoot)
      : unixProcessCount(execFile, pid);
    return count > 0 ? { status: "busy", count } : { status: "clear", count: 0 };
  } catch {
    return { status: "unknown", count: 0 };
  }
}
