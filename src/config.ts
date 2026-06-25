import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { OcxConfig } from "./types";

let _atomicSeq = 0;
/**
 * Write a file atomically (temp + rename) so concurrent writers — e.g. `ocx stop` and the
 * proxy's own shutdown handler both restoring Codex — can never leave a half-written file.
 */
export function atomicWriteFile(path: string, content: string): void {
  const tmp = `${path}.ocx.${process.pid}.${++_atomicSeq}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

function resolveConfigDir(): string {
  return process.env["OPENCODEX_HOME"] || join(homedir(), ".opencodex");
}

function resolveConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

function resolvePidPath(): string {
  return join(resolveConfigDir(), "ocx.pid");
}

const warnedConfigFallbacks = new Set<string>();

const providerConfigSchema = z.object({
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
}).passthrough();

const configSchema = z.object({
  port: z.number().int().min(0).max(65535).default(10100),
  providers: z.record(z.string(), providerConfigSchema),
  defaultProvider: z.string().min(1),
}).passthrough().superRefine((config, ctx) => {
  if (Object.keys(config.providers).length > 0 && !(config.defaultProvider in config.providers)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultProvider"],
      message: "defaultProvider must exist in providers",
    });
  }
});

/**
 * Default featured subagent models (native GPT) seeded on a fresh install and when `subagentModels`
 * is unset. Codex's spawn_agent advertises the first 5 featured catalog entries; these are the GPT
 * natives the installed Codex actually ships. The user can remove any in the GUI — once they set the
 * list (even to []), it is respected, so removals persist (start-up only seeds the UNSET case).
 * Kept to ids ChatGPT accepts; the start-up seed prefers the live catalog's native slugs.
 */
export const DEFAULT_SUBAGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];

export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getConfigPath(): string {
  return resolveConfigPath();
}

export function getPidPath(): string {
  return resolvePidPath();
}

export function hardenConfigDir(): void {
  const dir = getConfigDir();
  if (existsSync(dir)) {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

export function hardenExistingSecret(path: string): void {
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

export function loadConfig(): OcxConfig {
  const dir = getConfigDir();
  const configPath = getConfigPath();
  hardenConfigDir();
  hardenExistingSecret(configPath);
  hardenExistingSecret(join(dir, "auth.json"));
  if (!existsSync(configPath)) {
    return getDefaultConfig();
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return configSchema.parse(JSON.parse(raw)) as OcxConfig;
  } catch (error) {
    warnAndBackupInvalidConfig(configPath, error);
    return getDefaultConfig();
  }
}

export function saveConfig(config: OcxConfig): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best-effort on existing dir */ }
  }
  atomicWriteFile(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
  return config.websockets === true;
}

export function codexAutoStartEnabled(config: Pick<OcxConfig, "codexAutoStart">): boolean {
  return config.codexAutoStart !== false;
}

export function getDefaultConfig(): OcxConfig {
  // Fresh-install default: works out of the box with Codex's ChatGPT OAuth (no API key).
  // gpt-* requests forward the caller's incoming OAuth headers to the ChatGPT backend.
  // Adding extra providers (e.g. opencode-go) and switching defaultProvider is a user/runtime choice.
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    subagentModels: [...DEFAULT_SUBAGENT_MODELS],
    websockets: false,
    codexAutoStart: true,
  };
}

export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) return process.env[match[1]];
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

export function writePid(pid: number): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    hardenConfigDir();
  }
  writeFileSync(getPidPath(), String(pid), "utf-8");
}

export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return pid;
      return null;
    }
  } catch {
    return null;
  }
}

export function removePid(): void {
  try {
    unlinkSync(getPidPath());
  } catch { /* ignore */ }
}

function warnAndBackupInvalidConfig(configPath: string, error: unknown): void {
  if (warnedConfigFallbacks.has(configPath)) return;
  warnedConfigFallbacks.add(configPath);

  const backupPath = backupInvalidConfig(configPath);
  const reason = error instanceof z.ZodError
    ? error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
    : error instanceof Error ? error.message : String(error);
  const backupNote = backupPath ? ` A backup was written to ${backupPath}.` : "";
  console.error(`Could not load opencodex config at ${configPath}: ${reason}. Using default config.${backupNote}`);
}

function backupInvalidConfig(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  const backupPath = `${configPath}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    copyFileSync(configPath, backupPath);
    try { chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    return backupPath;
  } catch {
    return null;
  }
}
