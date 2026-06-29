import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CODEX_CONFIG_PATH } from "./codex-paths";
import { redactUserPath } from "./redact";

// Mirrors codex-rs core-plugins/src/marketplace.rs MARKETPLACE_MANIFEST_RELATIVE_PATHS.
// A marketplace root "resolves" only when one of these files exists under it.
const MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

const OPENAI_BUNDLED_MARKETPLACE_NAME = "openai-bundled";

// Plugins the issue (#43) calls out. Treated as data, not as an authoritative
// allowlist: codex-rs only allowlists chrome/computer-use, but the diagnostic
// just reports presence, so listing browser here is informational only.
const COMMON_BUNDLED_PLUGINS = ["computer-use", "browser", "chrome"] as const;

export type CodexPluginsDiagnostic =
  | { applicable: false; reason: string; summary: string }
  | {
      applicable: true;
      stale: boolean;
      marketplace: {
        name: string;
        present: boolean;
        sourceType: string | null;
        source: string | null;
        resolvesToManifest: boolean;
      };
      bundledPlugins: Array<{ id: string; configured: boolean }>;
      suggestedRepair: string | null;
      summary: string;
    };

/** True when the table at `[marketplaces.<name>]` exists in the config text. */
function readMarketplaceTable(configText: string, name: string): Record<string, string> | null {
  // Split on CRLF or LF: config.toml on Windows (the platform this diagnostic
  // targets) uses CRLF, and a leftover \r would defeat the `$`-anchored regexes.
  const lines = configText.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[marketplaces\\.(?:"${escapeRegExp(name)}"|${escapeRegExp(name)})\\]\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (header.test(lines[i] ?? "")) { start = i + 1; break; }
  }
  if (start === -1) return null;

  const table: Record<string, string> = {};
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\[/.test(line)) break; // next table starts; stop
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:\\.|[^"])*"|'[^']*'|[^#]+?)\s*(?:#.*)?$/);
    if (!m) continue;
    table[m[1]] = unquoteTomlValue(m[2].trim());
  }
  return table;
}

function unquoteTomlValue(raw: string): string {
  if (raw.startsWith("\"")) {
    try { return JSON.parse(raw) as string; } catch { return raw.slice(1, -1); }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return raw;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A local marketplace `source` resolves when it holds a supported manifest. */
function sourceResolvesToManifest(source: string): boolean {
  if (!isAbsolute(source)) return false;
  if (!existsSync(source)) return false;
  return MARKETPLACE_MANIFEST_RELATIVE_PATHS.some(rel => existsSync(join(source, rel)));
}

/**
 * Read-only diagnostic for the Codex `openai-bundled` plugin marketplace.
 *
 * Only meaningful on Windows, where app-package paths embed the app version and
 * go stale after an update. On other platforms it reports "not applicable".
 * NEVER mutates config.toml, never invokes `codex plugin marketplace add`.
 */
export function diagnoseCodexBundledPlugins(
  options: { platform?: NodeJS.Platform; configPath?: string } = {},
): CodexPluginsDiagnostic {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      applicable: false,
      reason: "not_windows",
      summary: "not applicable (bundled-marketplace staleness is Windows-specific)",
    };
  }

  const configPath = options.configPath ?? CODEX_CONFIG_PATH;
  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch {
    return {
      applicable: false,
      reason: "config_unreadable",
      summary: "not applicable (Codex config.toml not found or unreadable)",
    };
  }

  const table = readMarketplaceTable(configText, OPENAI_BUNDLED_MARKETPLACE_NAME);
  const present = table !== null;
  const sourceType = table?.source_type ?? null;
  const source = table?.source ?? null;
  const isLocal = sourceType === "local" && !!source;
  const resolvesToManifest = isLocal ? sourceResolvesToManifest(source as string) : false;

  // Stale = a registered local bundled marketplace whose source no longer
  // resolves to a manifest. A missing marketplace is "not stale" but flagged
  // separately by `present: false`.
  const stale = present && isLocal && !resolvesToManifest;

  const bundledPlugins = COMMON_BUNDLED_PLUGINS.map(id => ({
    id,
    configured: new RegExp(`\\[plugins\\.(?:"${escapeRegExp(`${id}@${OPENAI_BUNDLED_MARKETPLACE_NAME}`)}")\\]`).test(configText),
  }));

  const suggestedRepair = stale
    ? `codex plugin marketplace add <current ${OPENAI_BUNDLED_MARKETPLACE_NAME} path under the installed Codex app>`
    : null;

  const summary = !present
    ? `no [marketplaces.${OPENAI_BUNDLED_MARKETPLACE_NAME}] entry in Codex config`
    : stale
      ? `stale: registered ${OPENAI_BUNDLED_MARKETPLACE_NAME} source no longer resolves to a marketplace manifest`
      : `ok: ${OPENAI_BUNDLED_MARKETPLACE_NAME} marketplace resolves`;

  return {
    applicable: true,
    stale,
    marketplace: {
      name: OPENAI_BUNDLED_MARKETPLACE_NAME,
      present,
      sourceType,
      source: source ? redactUserPath(source) : null,
      resolvesToManifest,
    },
    bundledPlugins,
    suggestedRepair,
    summary,
  };
}
