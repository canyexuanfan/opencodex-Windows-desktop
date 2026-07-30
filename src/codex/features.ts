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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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

function mergeTrailingComments(existing?: string, migrated?: string): string {
  if (!existing) return migrated ?? "";
  if (!migrated || existing.trim() === migrated.trim()) return existing;
  const migratedText = migrated.replace(/^\s*#\s*/, "");
  if (existing.replace(/^\s*#\s*/, "").split(";").map(part => part.trim()).includes(migratedText.trim())) return existing;
  return `${existing}; ${migratedText}`;
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

/** Current legacy v1 `[agents] max_threads`, or null when absent/invalid. */
export function getAgentsMaxThreads(configPath?: string): number | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const agents = tomlTableBody(content, "agents");
  if (agents === null) return null;
  const m = agents.match(/^\s*max_threads\s*=\s*(\d+)\s*(?:#.*)?$/m);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Current `features.multi_agent_v2.max_concurrent_threads_per_session`, from
 * either the dedicated or inline-table form; null means the Codex default.
 */
export function getMaxConcurrentThreads(configPath?: string): number | null {
  const content = readConfigText(configPath);
  if (content === null) return null;
  const table = tomlTableBody(content, "features.multi_agent_v2");
  const features = tomlTableBody(content, "features");
  const inline = features?.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}/m);
  const m = table?.match(/^\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?:#.*)?$/m)
    ?? inline?.[1].match(/(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?:,|$)/);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/** Largest V1 child limit we translate. Well below Number.MAX_SAFE_INTEGER and far
 *  above any real concurrency setting; upstream's usize saturates, ours would silently
 *  lose precision. */
const MAX_TRANSLATABLE_V1_CHILD_LIMIT = 1_000_000;
/** The V2 side is one larger by construction: it counts the root agent's own slot, so
 *  the image of the maximum V1 value must itself be translatable back. */
const MAX_TRANSLATABLE_V2_TOTAL_LIMIT = MAX_TRANSLATABLE_V1_CHILD_LIMIT + 1;

export function isTranslatableV1ChildLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_V1_CHILD_LIMIT;
}

export function isTranslatableV2TotalLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_TRANSLATABLE_V2_TOTAL_LIMIT;
}

/**
 * Upstream counts the root agent inside the V2 thread limit but not inside the legacy
 * `[agents]` limit (codex-rs core/src/config/mod.rs resolve_multi_agent_v2_config applies
 * saturating_add(1) to the [agents] value; the inverse saturating_sub(1) appears at
 * mod.rs:1555). These helpers keep our migrations on the same side of that boundary.
 */
export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  if (!isTranslatableV1ChildLimit(childLimit)) {
    throw new RangeError(`v1 child limit out of translatable range: ${childLimit}`);
  }
  return childLimit + 1;
}

/**
 * Inverse of `v1ChildLimitToV2TotalLimit`. A V2 total of 1 means "root only, no
 * children", which has no representable legacy child count >= 1, so it clamps to 1
 * rather than writing 0 and tripping upstream's `>= 1` validation.
 */
export function v2TotalLimitToV1ChildLimit(totalLimit: number): number {
  if (!isTranslatableV2TotalLimit(totalLimit)) {
    throw new RangeError(`v2 total limit out of translatable range: ${totalLimit}`);
  }
  return Math.max(1, totalLimit - 1);
}

/**
 * Persist `features.multi_agent_v2.max_concurrent_threads_per_session = value`.
 * Scoped edit in either the dedicated table or `[features]` boolean/inline form.
 * Boolean form is upgraded to an inline config so the numeric value remains
 * attached to the feature without a TOML key conflict. Idempotent on equal value.
 */
export function setMaxConcurrentThreads(value: number, configPath?: string, migratedComment?: string): { ok: true; changed: boolean } | { ok: false; error: string } {
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
    const featuresHeader = lines.findIndex(l => /^\s*\[features\]\s*(?:#.*)?$/.test(l));
    if (featuresHeader === -1) return { ok: false, error: "multi_agent_v2 feature config not found — enable v2 first (ocx v2 on)" };
    let featuresEnd = lines.length;
    for (let i = featuresHeader + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { featuresEnd = i; break; }
    }
    const boolRe = /^(\s*)multi_agent_v2\s*=\s*(true|false)(\s*#.*)?$/;
    const inlineRe = /^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$/;
    for (let i = featuresHeader + 1; i < featuresEnd; i++) {
      const bool = lines[i].match(boolRe);
      if (bool) {
        lines[i] = `${bool[1]}multi_agent_v2 = { enabled = ${bool[2]}, max_concurrent_threads_per_session = ${value} }${mergeTrailingComments(bool[3], migratedComment)}`;
        atomicWriteFile(path, applyEol(lines.join("\n"), eol));
        return { ok: true, changed: true };
      }
      const inline = lines[i].match(inlineRe);
      if (!inline) continue;
      const existing = inline[2].match(/(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*(\d+)\s*(?=,|$)/);
      if (existing && Number(existing[1]) === value && (!migratedComment || migratedComment === inline[3])) return { ok: true, changed: false };
      const body = existing
        ? inline[2].replace(/(^|,)\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?=,|$)/, `$1 max_concurrent_threads_per_session = ${value}`)
        : `${inline[2].trim()}${inline[2].trim() ? ", " : ""}max_concurrent_threads_per_session = ${value}`;
      lines[i] = `${inline[1]}multi_agent_v2 = { ${body.trim()} }${mergeTrailingComments(inline[3], migratedComment)}`;
      atomicWriteFile(path, applyEol(lines.join("\n"), eol));
      return { ok: true, changed: true };
    }
    return { ok: false, error: "multi_agent_v2 feature config not found — enable v2 first (ocx v2 on)" };
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const keyRe = /^(\s*)max_concurrent_threads_per_session\s*=\s*(\d+)(\s*#.*)?$/;
  for (let i = headerIdx + 1; i < end; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    if (Number(m[2]) === value && (!migratedComment || migratedComment === m[3])) return { ok: true, changed: false };
    lines[i] = `${m[1]}max_concurrent_threads_per_session = ${value}${mergeTrailingComments(m[3], migratedComment)}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  lines.splice(headerIdx + 1, 0, `max_concurrent_threads_per_session = ${value}${migratedComment ?? ""}`);
  atomicWriteFile(path, applyEol(lines.join("\n"), eol));
  return { ok: true, changed: true };
}

type ConfigEditResult = { ok: true; changed: boolean } | { ok: false; error: string };

function editAgentsMaxThreads(value: number | null, configPath?: string, migratedComment?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /^\s*\[agents\]\s*(?:#.*)?$/.test(l));
  if (headerIdx === -1) {
    if (value === null) return { ok: true, changed: false };
    const separator = lines.length > 0 && lines[lines.length - 1] !== "" ? [""] : [];
    lines.push(...separator, "[agents]", `max_threads = ${value}${migratedComment ?? ""}`);
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  const keyRe = /^(\s*)max_threads\s*=\s*(\d+)(\s*#.*)?$/;
  for (let i = headerIdx + 1; i < end; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    if (value === null) lines.splice(i, 1);
    else if (Number(m[2]) === value && (!migratedComment || migratedComment === m[3])) return { ok: true, changed: false };
    else lines[i] = `${m[1]}max_threads = ${value}${mergeTrailingComments(m[3], migratedComment)}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  if (value === null) return { ok: true, changed: false };
  lines.splice(headerIdx + 1, 0, `max_threads = ${value}${migratedComment ?? ""}`);
  atomicWriteFile(path, applyEol(lines.join("\n"), eol));
  return { ok: true, changed: true };
}

function removeMaxConcurrentThreads(configPath?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const eol = dominantEol(content);
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/.test(l));
  if (headerIdx !== -1) {
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { end = i; break; }
    }
    const keyIdx = lines.findIndex((line, i) => i > headerIdx && i < end && /^\s*max_concurrent_threads_per_session\s*=/.test(line));
    if (keyIdx !== -1) {
      lines.splice(keyIdx, 1);
      atomicWriteFile(path, applyEol(lines.join("\n"), eol));
      return { ok: true, changed: true };
    }
  }
  const featuresHeader = lines.findIndex(l => /^\s*\[features\]\s*(?:#.*)?$/.test(l));
  if (featuresHeader === -1) return { ok: true, changed: false };
  let featuresEnd = lines.length;
  for (let i = featuresHeader + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { featuresEnd = i; break; }
  }
  const inlineRe = /^(\s*)multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)?$/;
  for (let i = featuresHeader + 1; i < featuresEnd; i++) {
    const inline = lines[i].match(inlineRe);
    if (!inline || !/(?:^|,)\s*max_concurrent_threads_per_session\s*=/.test(inline[2])) continue;
    const body = inline[2]
      .replace(/^\s*max_concurrent_threads_per_session\s*=\s*\d+\s*,?\s*/, "")
      .replace(/,\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?=,|$)/, "")
      .trim();
    lines[i] = `${inline[1]}multi_agent_v2 = { ${body} }${inline[3] ?? ""}`;
    atomicWriteFile(path, applyEol(lines.join("\n"), eol));
    return { ok: true, changed: true };
  }
  return { ok: true, changed: false };
}

function ensureDisabledV2Config(value: number | null, configPath?: string, migratedComment?: string): ConfigEditResult {
  const path = configPath ?? activeCodexConfigPath();
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  if (tomlTableBody(content, "features.multi_agent_v2") !== null || tomlTableBody(content, "features")?.match(/^\s*multi_agent_v2\s*=/m)) {
    if (value === null) return { ok: true, changed: false };
    return setMaxConcurrentThreads(value, path, migratedComment);
  }
  const eol = dominantEol(content);
  const suffix = content.endsWith("\n") || content.length === 0 ? "" : eol;
  const table = `[features.multi_agent_v2]${eol}enabled = false${value === null ? "" : `${eol}max_concurrent_threads_per_session = ${value}${migratedComment ?? ""}`}${eol}`;
  atomicWriteFile(path, `${content}${suffix}${content.length > 0 && !content.endsWith(`${eol}${eol}`) ? eol : ""}${table}`);
  return { ok: true, changed: true };
}

/**
 * The effective concurrency limit expressed in the units of the currently ACTIVE
 * backend: under V2 the total-thread limit upstream enforces, under V1 the child
 * limit. The active backend's own key wins; the other backend's key is translated
 * across the root-agent slot. Display path only — never throws: a stored value
 * outside the translatable range is returned raw (at that magnitude the ±1 root
 * slot is already below float precision, and crashing `ocx v2 status` or
 * `GET /api/v2` is not a price worth paying for a translation that means nothing).
 * Migration code uses `discoverStoredThreadLimit` instead, which keeps provenance.
 */
export function getLogicalMaxThreads(configPath?: string): number | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return v2;
    const legacy = getAgentsMaxThreads(configPath);
    if (legacy === null) return null;
    return isTranslatableV1ChildLimit(legacy) ? v1ChildLimitToV2TotalLimit(legacy) : legacy;
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return legacy;
  const v2 = getMaxConcurrentThreads(configPath);
  if (v2 === null) return null;
  return isTranslatableV2TotalLimit(v2) ? v2TotalLimitToV1ChildLimit(v2) : v2;
}

type ThreadLimitUnits = "v1-child" | "v2-total";

/**
 * Which storage the active limit lives in, in that storage's native units. The
 * active backend's own key wins; the other backend's key is the fallback and keeps
 * ITS units. Never translates and never throws. This is the migration-side sibling
 * of `getLogicalMaxThreads`: a migration needs to know exactly which storage the
 * value came from, and a display function's raw fallback would lose that.
 */
function discoverStoredThreadLimit(configPath?: string): { value: number; units: ThreadLimitUnits } | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return { value: v2, units: "v2-total" };
    const legacy = getAgentsMaxThreads(configPath);
    return legacy === null ? null : { value: legacy, units: "v1-child" };
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return { value: legacy, units: "v1-child" };
  const v2 = getMaxConcurrentThreads(configPath);
  return v2 === null ? null : { value: v2, units: "v2-total" };
}

function activeThreadComment(content: string, v2Enabled: boolean): string | undefined {
  const legacy = tomlTableBody(content, "agents")?.match(/^\s*max_threads\s*=\s*\d+(\s*#.*)$/m)?.[1];
  const dedicated = tomlTableBody(content, "features.multi_agent_v2")
    ?.match(/^\s*max_concurrent_threads_per_session\s*=\s*\d+(\s*#.*)$/m)?.[1];
  const features = tomlTableBody(content, "features");
  const inlineLine = features?.match(/^\s*multi_agent_v2\s*=\s*\{([^}]*)\}(\s*#.*)$/m);
  const inline = inlineLine && /(?:^|,)\s*max_concurrent_threads_per_session\s*=\s*\d+\s*(?:,|$)/.test(inlineLine[1])
    ? inlineLine[2]
    : undefined;
  return v2Enabled ? dedicated ?? inline ?? legacy : legacy ?? dedicated ?? inline;
}

let migrationEditSeq = 0;
function applyConfigEditsAtomically(path: string, edit: (tempPath: string) => ConfigEditResult): ConfigEditResult {
  const content = readConfigText(path);
  if (content === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const tempPath = `${path}.ocx-migration.${process.pid}.${++migrationEditSeq}`;
  try {
    atomicWriteFile(tempPath, content);
    const result = edit(tempPath);
    if (!result.ok) return result;
    const edited = readConfigText(tempPath);
    if (edited === null) return { ok: false, error: "temporary config migration output is unreadable" };
    if (edited === content) return { ok: true, changed: false };
    atomicWriteFile(path, edited);
    return { ok: true, changed: true };
  } finally {
    try { unlinkSync(tempPath); } catch { /* already absent */ }
  }
}

export type MultiAgentV2TransitionResult =
  | { ok: true; changed: boolean; threadLimit: number | null }
  | { ok: false; error: string };

function transitionConfigError(content: string): string | null {
  if (/^\s*(?:features\.multi_agent_v2(?:\.[A-Za-z0-9_]+)?|agents\.max_threads)\s*=/m.test(content)) {
    return "dotted multi-agent config keys are not supported for automatic migration";
  }
  const dedicatedTables = content.match(/^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/gm) ?? [];
  const featuresTables = content.match(/^\s*\[features\]\s*(?:#.*)?$/gm) ?? [];
  const agentsTables = content.match(/^\s*\[agents\]\s*(?:#.*)?$/gm) ?? [];
  if (dedicatedTables.length > 1 || featuresTables.length > 1 || agentsTables.length > 1) {
    return "duplicate multi-agent TOML tables cannot be migrated safely";
  }
  const features = tomlTableBody(content, "features");
  const featureDefs = features?.match(/^\s*multi_agent_v2\s*=/gm) ?? [];
  if (featureDefs.length > 1 || (dedicatedTables.length === 1 && featureDefs.length === 1)) {
    return "duplicate multi_agent_v2 definitions cannot be migrated safely";
  }
  if (features && /^\s*multi_agent_v2\.(?:enabled|max_concurrent_threads_per_session)\s*=/m.test(features)) {
    return "dotted multi_agent_v2 fields are not supported for automatic migration";
  }
  const agents = tomlTableBody(content, "agents");
  if ((agents?.match(/^\s*max_threads\s*=/gm) ?? []).length > 1) {
    return "duplicate agents.max_threads definitions cannot be migrated safely";
  }
  const dedicated = tomlTableBody(content, "features.multi_agent_v2");
  if ((dedicated?.match(/^\s*max_concurrent_threads_per_session\s*=/gm) ?? []).length > 1) {
    return "duplicate v2 thread-limit definitions cannot be migrated safely";
  }
  return null;
}

/**
 * Toggle native multi_agent_v2 while moving the active thread limit to the key
 * valid for the destination version. Any failed command/postcondition restores
 * the exact original config bytes.
 */
export function transitionMultiAgentV2(
  enabled: boolean,
  toggleFeature: (enabled: boolean) => void,
  options: { configPath?: string; threadLimit?: number } = {},
): MultiAgentV2TransitionResult {
  if (options.threadLimit !== undefined && (!Number.isInteger(options.threadLimit) || options.threadLimit < 1)) {
    return { ok: false, error: "thread limit must be an integer >= 1" };
  }
  const path = options.configPath ?? activeCodexConfigPath();
  const original = readConfigText(path);
  if (original === null) return { ok: false, error: `config.toml not readable at ${path}` };
  const preflightError = transitionConfigError(original);
  if (preflightError) return { ok: false, error: preflightError };
  const beforeEnabled = isMultiAgentV2Enabled(path);
  // A caller-supplied limit is already in the DESTINATION backend's units and is
  // never translated. A discovered limit carries the units of the storage it was
  // read from and crosses the root-slot boundary only when those units differ
  // from the destination's — which covers both backend flips and same-state
  // storage migrations (legacy-only under V2, V2-only under V1). The range
  // check runs only when a translation is actually needed, and before the try
  // block so an out-of-range stored value is a normal error result rather than
  // a RangeError escaping the rollback contract.
  const discovered = discoverStoredThreadLimit(path);
  const destinationUnits: ThreadLimitUnits = enabled ? "v2-total" : "v1-child";
  let threadLimit = options.threadLimit ?? discovered?.value ?? null;
  if (options.threadLimit === undefined && discovered !== null && discovered.units !== destinationUnits) {
    const translatable = discovered.units === "v1-child" ? isTranslatableV1ChildLimit : isTranslatableV2TotalLimit;
    if (!translatable(discovered.value)) {
      return { ok: false, error: `stored thread limit out of translatable range: ${discovered.value}` };
    }
    threadLimit = discovered.units === "v1-child"
      ? v1ChildLimitToV2TotalLimit(discovered.value)
      : v2TotalLimitToV1ChildLimit(discovered.value);
  }
  const migratedComment = activeThreadComment(original, beforeEnabled);
  try {
    if (enabled) {
      if (!beforeEnabled) {
        const staged = applyConfigEditsAtomically(path, tempPath => {
          const v2 = ensureDisabledV2Config(threadLimit, tempPath, migratedComment);
          if (!v2.ok) return v2;
          return editAgentsMaxThreads(null, tempPath);
        });
        if (!staged.ok) throw new Error(staged.error);
        toggleFeature(true);
      }
      if (!isMultiAgentV2Enabled(path)) throw new Error("codex feature command did not enable multi_agent_v2");
      const target = applyConfigEditsAtomically(path, tempPath => {
        const v2 = threadLimit === null
          ? removeMaxConcurrentThreads(tempPath)
          : setMaxConcurrentThreads(threadLimit, tempPath, migratedComment);
        if (!v2.ok) return v2;
        return editAgentsMaxThreads(null, tempPath);
      });
      if (!target.ok) throw new Error(target.error);
      if (hasAgentsMaxThreads(path) || getMaxConcurrentThreads(path) !== threadLimit) throw new Error("v2 thread-limit migration postcondition failed");
    } else {
      if (beforeEnabled) toggleFeature(false);
      if (isMultiAgentV2Enabled(path)) throw new Error("codex feature command did not disable multi_agent_v2");
      const target = applyConfigEditsAtomically(path, tempPath => {
        const v2 = removeMaxConcurrentThreads(tempPath);
        if (!v2.ok) return v2;
        return editAgentsMaxThreads(threadLimit, tempPath, migratedComment);
      });
      if (!target.ok) throw new Error(target.error);
      if (getMaxConcurrentThreads(path) !== null || getAgentsMaxThreads(path) !== threadLimit) throw new Error("v1 thread-limit migration postcondition failed");
    }
    return { ok: true, changed: readConfigText(path) !== original, threadLimit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      atomicWriteFile(path, original);
      return { ok: false, error: message };
    } catch (rollbackErr) {
      return { ok: false, error: `${message}; rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}` };
    }
  }
}
