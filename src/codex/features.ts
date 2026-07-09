/**
 * features.ts — codex feature-flag view for $CODEX_HOME/config.toml.
 *
 * Used by the catalog v2-gated-ultra policy (devlog/260709_v2_gated_ultra) and the
 * `ocx v2` toggle surface. The FLAG itself is never written here — toggling goes
 * through the official `codex features enable|disable` CLI (format-preserving).
 * The one write this module owns is the numeric
 * `features.multi_agent_v2.max_concurrent_threads_per_session` scalar
 * (setMaxConcurrentThreads): the codex CLI has no persisted setter for nested
 * feature config (`-c` is per-invocation only), so ocx does a scoped,
 * EOL-preserving line edit — same practice as codex/inject.ts.
 *
 * CODEX_HOME is resolved at CALL time (activeCodexConfigPath pattern, mirrors
 * catalog.ts:40-54) so tests can point fixtures via env or the explicit
 * `configPath` parameter without fighting the module-load-time const in paths.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { atomicWriteFile, expandUserPath } from "../config";
import { CODEX_CONFIG_PATH } from "./paths";

// EOL preservation, local copies of inject.ts dominantEol/applyEol: importing
// inject here would close a module cycle (features -> inject -> catalog -> features).
function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

function applyEol(content: string, eol: "\r\n" | "\n"): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return eol === "\n" ? normalized : normalized.replace(/\n/g, "\r\n");
}

function activeCodexConfigPath(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return CODEX_CONFIG_PATH;
  const path = resolve(expandUserPath(raw));
  try {
    return join(realpathSync.native(path), "config.toml");
  } catch {
    return join(path, "config.toml");
  }
}

function readConfigText(configPath?: string): string | null {
  const path = configPath ?? activeCodexConfigPath();
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Body lines of a TOML table `[header]` up to (not including) the next table header. */
function tomlTableBody(content: string, header: string): string | null {
  const lines = content.split("\n");
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^\s*\[/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function tomlBoolInBody(body: string, key: string): boolean | null {
  const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "m"));
  return m ? m[1] === "true" : null;
}

/**
 * TRUE when the codex `multi_agent_v2` feature is enabled in config.toml.
 * Recognizes both shipped forms (codex-rs features/src/tests.rs):
 *   [features.multi_agent_v2]           [features]
 *   enabled = true                      multi_agent_v2 = true
 * plus the inline-table form `multi_agent_v2 = { enabled = true, ... }`.
 * Missing file/key -> false (upstream default_enabled = false).
 */
export function isMultiAgentV2Enabled(configPath?: string): boolean {
  const content = readConfigText(configPath);
  if (content === null) return false;

  const table = tomlTableBody(content, "features.multi_agent_v2");
  if (table !== null) {
    const enabled = tomlBoolInBody(table, "enabled");
    if (enabled !== null) return enabled;
    // A bare [features.multi_agent_v2] table without `enabled` counts as on
    // (FeatureToml::Config with enabled: None materializes as enabled upstream
    // only when set; be conservative and require the boolean).
    return false;
  }

  const features = tomlTableBody(content, "features");
  if (features !== null) {
    const bool = tomlBoolInBody(features, "multi_agent_v2");
    if (bool !== null) return bool;
    const inline = features.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m);
    if (inline) {
      const enabled = inline[1].match(/enabled\s*=\s*(true|false)/);
      if (enabled) return enabled[1] === "true";
    }
  }
  return false;
}

/**
 * TRUE when config.toml still carries `[agents] max_threads` — codex-rs REFUSES to
 * boot with that key while multi_agent_v2 is enabled ("agents.max_threads cannot be
 * set when features.multi_agent_v2 is enabled", core/src/config/mod.rs:1421). The
 * `ocx v2 on` flow warns about it instead of editing config itself.
 */
export function hasAgentsMaxThreads(configPath?: string): boolean {
  const content = readConfigText(configPath);
  if (content === null) return false;
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return false;
  return /^\s*max_threads\s*=/m.test(agents);
}

/**
 * Current `features.multi_agent_v2.max_concurrent_threads_per_session`, or null when
 * the table/key is absent (codex-rs then applies its own default).
 */
export function getMaxConcurrentThreads(configPath?: string): number | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const table = tomlTableBody(content, "features.multi_agent_v2");
  if (table === null) return null;
  const m = table.match(/^\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?:#.*)?$/m);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/**
 * Persist `features.multi_agent_v2.max_concurrent_threads_per_session = value`.
 * Scoped line edit inside the existing `[features.multi_agent_v2]` table only:
 * replaces the key line when present, else inserts it right under the header.
 * Refuses (returns an error string) when the table is missing — creating it next
 * to a boolean-form `multi_agent_v2 = true` would be a TOML key conflict, and the
 * table is exactly what `codex features enable multi_agent_v2` materializes, so
 * "enable first" is the honest remedy. Idempotent: equal value -> no write.
 */
export function setMaxConcurrentThreads(value: number, configPath?: string): { ok: true; changed: boolean } | { ok: false; error: string } {
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: "max_concurrent_threads_per_session must be an integer >= 1" };
  }
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };

  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerRe = /^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/;
  const headerIdx = lines.findIndex(l => headerRe.test(l));
  if (headerIdx === -1) {
    return { ok: false, error: "[features.multi_agent_v2] table not found — enable v2 first (ocx v2 on)" };
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const keyRe = /^(\s*)max_concurrent_threads_per_session\s*=\s*(\d+)(\s*#.*)?$/;
  for (let i = headerIdx + 1; i < end; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    if (Number(m[2]) === value) return { ok: true, changed: false };
    lines[i] = `${m[1]}max_concurrent_threads_per_session = ${value}${m[3] ?? ""}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  lines.splice(headerIdx + 1, 0, `max_concurrent_threads_per_session = ${value}`);
  atomicWriteFile(path, applyEol(lines.join("\n"), eol));
  return { ok: true, changed: true };
}
