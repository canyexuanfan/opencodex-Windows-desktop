import { delimiter, dirname, extname, join } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getConfigDir } from "./config";

const SHIM_MARKER = "opencodex codex autostart shim";
const CODEX_INTERNAL_COMMANDS = [
  "app-server",
  "archive",
  "apply",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "exec",
  "exec-server",
  "features",
  "fork",
  "help",
  "login",
  "logout",
  "mcp",
  "plugin",
  "resume",
  "review",
  "sandbox",
  "unarchive",
  "update",
];

interface ShimState {
  platform: NodeJS.Platform;
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  wrappers?: ShimFileState[];
}

interface ShimFileState {
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
}

function cliEntry(): { bun: string; cli: string } {
  return { bun: process.execPath, cli: join(import.meta.dir, "cli.ts") };
}

function commandNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [name, ...exts.flatMap(ext => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
}

function isShim(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function findCodexOnPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of commandNames("codex")) {
      const path = join(dir, name);
      if (!existsSync(path) || isShim(path)) continue;
      try {
        if (!lstatSync(path).isDirectory()) return path;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function findWindowsCodexTargets(): ShimFileState[] | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const cmd = join(dir, "codex.cmd");
    const ps1 = join(dir, "codex.ps1");
    const targets: ShimFileState[] = [];
    for (const path of [cmd, ps1]) {
      if (!existsSync(path) || isShim(path)) continue;
      try {
        if (!lstatSync(path).isDirectory()) {
          targets.push({ wrapperPath: path, originalPath: path, backupPath: backupPathFor(path) });
        }
      } catch { /* keep scanning */ }
    }
    if (targets.length > 0) return targets;

    const exe = join(dir, "codex.exe");
    if (!existsSync(exe) || isShim(exe)) continue;
    try {
      if (lstatSync(exe).isDirectory()) continue;
      const wrapperPath = join(dir, "codex.cmd");
      if (existsSync(wrapperPath) && !isShim(wrapperPath)) continue;
      return [{ wrapperPath, originalPath: exe, backupPath: backupPathFor(exe) }];
    } catch { /* keep scanning */ }
  }
  return null;
}

function backupPathFor(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.opencodex-real${ext}` : `${path}.opencodex-real`;
}

export function buildUnixCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.join("|");
  return `#!/usr/bin/env sh
# ${SHIM_MARKER}
case "$1" in
  ${internalCommands}|--help|-h|--version|-V)
    ;;
  *)
    if [ -z "$OCX_SHIM_BYPASS" ]; then
      "${bunPath}" "${cliPath}" ensure >/dev/null 2>&1 || true
    fi
    ;;
esac
exec "${realCodexPath}" "$@"
`;
}

export function buildWindowsCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  const internalCommandChecks = CODEX_INTERNAL_COMMANDS.map(command => `if /I "%~1"=="${command}" goto run_codex`).join("\r\n");
  return `@echo off\r
rem ${SHIM_MARKER}\r
if not "%OCX_SHIM_BYPASS%"=="" goto run_codex\r
${internalCommandChecks}\r
if /I "%~1"=="--help" goto run_codex\r
if /I "%~1"=="-h" goto run_codex\r
if /I "%~1"=="--version" goto run_codex\r
if /I "%~1"=="-V" goto run_codex\r
"${bunPath}" "${cliPath}" ensure >nul 2>nul\r
:run_codex\r
"${realCodexPath}" %*\r
`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsPowerShellCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.map(command => psString(command)).join(", ");
  return `#!/usr/bin/env pwsh
# ${SHIM_MARKER}
$internalCommands = @(${internalCommands})
$firstArg = if ($args.Count -gt 0) { [string]$args[0] } else { "" }
$skipEnsure = $env:OCX_SHIM_BYPASS -or $internalCommands -contains $firstArg -or @("--help", "-h", "--version", "-V") -contains $firstArg
if (-not $skipEnsure) {
  & ${psString(bunPath)} ${psString(cliPath)} ensure *> $null
}
& ${psString(realCodexPath)} @args
exit $LASTEXITCODE
`;
}

function readState(): ShimState | null {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as ShimState;
  } catch {
    return null;
  }
}

function statePath(): string {
  return join(getConfigDir(), "codex-shim.json");
}

function writeState(state: ShimState): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function writeShim(wrapperPath: string, realCodexPath: string): void {
  const { bun, cli } = cliEntry();
  if (process.platform === "win32") {
    if (wrapperPath.toLowerCase().endsWith(".ps1")) {
      writeFileSync(wrapperPath, buildWindowsPowerShellCodexShim(realCodexPath, bun, cli), "utf8");
    } else {
      writeFileSync(wrapperPath, buildWindowsCodexShim(realCodexPath, bun, cli), "utf8");
    }
  } else {
    writeFileSync(wrapperPath, buildUnixCodexShim(realCodexPath, bun, cli), "utf8");
    chmodSync(wrapperPath, 0o755);
  }
}

function stateFiles(state: ShimState): ShimFileState[] {
  return state.wrappers?.length
    ? state.wrappers
    : [{ wrapperPath: state.wrapperPath, originalPath: state.originalPath, backupPath: state.backupPath }];
}

function primaryState(files: ShimFileState[]): ShimState {
  const first = files[0];
  return { platform: process.platform, ...first, wrappers: files };
}

function replaceOwnedBackup(sourcePath: string, backupPath: string): void {
  const oldBackupPath = `${backupPath}.old-${process.pid}`;
  if (existsSync(oldBackupPath)) unlinkSync(oldBackupPath);
  if (existsSync(backupPath)) renameSync(backupPath, oldBackupPath);
  try {
    renameSync(sourcePath, backupPath);
    if (existsSync(oldBackupPath)) unlinkSync(oldBackupPath);
  } catch (error) {
    if (!existsSync(backupPath) && existsSync(oldBackupPath)) renameSync(oldBackupPath, backupPath);
    throw error;
  }
}

function refreshShimFile(file: ShimFileState): boolean {
  if (existsSync(file.wrapperPath) && !isShim(file.wrapperPath)) {
    if (file.wrapperPath !== file.originalPath) return false;
    replaceOwnedBackup(file.wrapperPath, file.backupPath);
    writeShim(file.wrapperPath, file.backupPath);
    return true;
  }
  if (!existsSync(file.wrapperPath) && existsSync(file.backupPath)) {
    writeShim(file.wrapperPath, file.backupPath);
    return true;
  }
  if (file.originalPath !== file.wrapperPath && existsSync(file.originalPath) && existsSync(file.wrapperPath) && isShim(file.wrapperPath)) {
    replaceOwnedBackup(file.originalPath, file.backupPath);
    writeShim(file.wrapperPath, file.backupPath);
    return true;
  }
  return false;
}

export function installCodexShim(): { installed: boolean; message: string } {
  const existing = readState();
  if (existing) {
    const files = stateFiles(existing);
    let refreshed = false;
    for (const file of files) refreshed = refreshShimFile(file) || refreshed;
    const allInstalled = files.every(file => existsSync(file.wrapperPath) && existsSync(file.backupPath) && isShim(file.wrapperPath));
    if (refreshed || allInstalled) {
      writeState(primaryState(files));
      if (refreshed) {
        return {
          installed: true,
          message: `Codex update detected. Backed up new launcher and refreshed shim at ${files.map(f => f.wrapperPath).join(", ")}.`,
        };
      }
      return {
        installed: false,
        message: `Codex autostart shim already installed at ${files.map(f => f.wrapperPath).join(", ")}.`,
      };
    }
  }

  const targets = process.platform === "win32"
    ? findWindowsCodexTargets()
    : (() => {
      const originalPath = findCodexOnPath();
      return originalPath ? [{ wrapperPath: originalPath, originalPath, backupPath: backupPathFor(originalPath) }] : null;
    })();
  if (!targets) return { installed: false, message: "Could not find a codex executable on PATH." };

  for (const target of targets) {
    if (existsSync(target.backupPath)) return { installed: false, message: `Refusing to overwrite existing backup: ${target.backupPath}` };
  }
  for (const target of targets) {
    renameSync(target.originalPath, target.backupPath);
    writeShim(target.wrapperPath, target.backupPath);
  }
  writeState(primaryState(targets));
  return {
    installed: true,
    message: `Codex autostart shim installed at ${targets.map(t => t.wrapperPath).join(", ")}. Original saved at ${targets.map(t => t.backupPath).join(", ")}.`,
  };
}

export function uninstallCodexShim(): { removed: boolean; message: string } {
  const state = readState();
  if (!state) return { removed: false, message: "Codex autostart shim is not installed." };
  const files = stateFiles(state);
  for (const file of files) {
    if (existsSync(file.wrapperPath) && isShim(file.wrapperPath)) unlinkSync(file.wrapperPath);
  }
  for (const file of files) {
    if (existsSync(file.backupPath) && !existsSync(file.originalPath)) renameSync(file.backupPath, file.originalPath);
  }
  if (existsSync(statePath())) unlinkSync(statePath());
  return { removed: true, message: `Codex autostart shim removed. Restored ${files.map(f => f.originalPath).join(", ")}.` };
}

export function codexShimStatus(): string {
  const state = readState();
  if (!state) return "Codex autostart shim is not installed.";
  return stateFiles(state).map(file => {
    const wrapper = existsSync(file.wrapperPath)
      ? isShim(file.wrapperPath)
        ? "shim present"
        : "present but not an opencodex shim"
      : "missing";
    const backup = existsSync(file.backupPath) ? "present" : "missing";
    return `Codex autostart shim: wrapper ${wrapper} at ${file.wrapperPath}; original backup ${backup} at ${file.backupPath}.`;
  }).join("\n");
}
