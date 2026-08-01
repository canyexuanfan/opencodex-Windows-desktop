import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type NativeCodexProcessProbe =
  | { status: "clear"; count: 0 }
  | { status: "busy"; count: number }
  | { status: "unknown"; count: 0 };

function windowsProcessCount(): number {
  const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = [
    "$ErrorActionPreference='Stop';",
    "$self=$PID;",
    "$items=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and ($_.Name -match '^(?i:codex)(?:\\.exe)?$' -or $_.CommandLine -match '(?i)(?:^|[\\\\/\"\\s])codex(?:\\.exe|\\.cmd)?(?:[\"\\s]|$)') };",
    "@($items).Count",
  ].join(" ");
  const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 12_000,
    windowsHide: true,
  }).trim();
  const count = Number(output);
  if (!Number.isInteger(count) || count < 0) throw new Error("invalid process count");
  return count;
}

function unixProcessCount(): number {
  const output = execFileSync("ps", ["-eo", "pid=,comm=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  let count = 0;
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    const command = basename(match[2]!).toLowerCase();
    const firstArg = basename(match[3]!.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
    if (command === "codex" || command === "codex.exe" || firstArg === "codex" || firstArg === "codex.exe") count += 1;
  }
  return count;
}

/** Best-effort, read-only process probe. It never terminates a user process. */
export async function probeNativeCodexProcesses(): Promise<NativeCodexProcessProbe> {
  try {
    const count = process.platform === "win32" ? windowsProcessCount() : unixProcessCount();
    return count > 0 ? { status: "busy", count } : { status: "clear", count: 0 };
  } catch {
    return { status: "unknown", count: 0 };
  }
}
