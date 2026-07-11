import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Desktop3pModelEntry {
  name: string;
  labelOverride: string;
  anthropicFamilyTier: "opus";
  isFamilyDefault?: boolean;
}

export type Desktop3pConfigMode = "discovery" | "static";

interface Desktop3pMetadataEntry {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface Desktop3pMetadata {
  appliedId?: string;
  entries: Desktop3pMetadataEntry[];
  [key: string]: unknown;
}

let desktop3pRegistry = new Map<string, string>();

/** Derive a stable letter-first, three-character base36 code from a route key. */
export function deriveDesktop3pCode(route: string): string {
  const hash = createHash("sha256").update(route).digest();
  const n = hash.readUInt32BE(0) % 33696;
  const first = String.fromCharCode(97 + Math.floor(n / 1296));
  const rest = (n % 1296).toString(36).padStart(2, "0");
  return first + rest;
}

/**
 * Alias for one proxy model. Real Anthropic models pass through unchanged (they must
 * keep hitting the sk-ant native passthrough); everything else gets a Claude-shaped
 * `claude-opus-4-8-{code}` id. Opus 4.8 is chosen deliberately: Desktop's effort
 * selector is an allowlist keyed on exact supported model ids (Opus 4.8/4.7/4.6,
 * Sonnet 4.6 — devlog 131), and 4.6+ canonical ids are dateless, so the letter-first
 * 3-char suffix can never collide with a real id or a legacy date suffix.
 */
export function desktop3pAlias(provider: string, modelId: string): string {
  if (provider === "anthropic" && modelId.startsWith("claude-")) return modelId;
  return `claude-opus-4-8-${deriveDesktop3pCode(`${provider}/${modelId}`)}`;
}

/** Pre-rename alias shape (claude-opus-4-{code}) — still decoded for stale Desktop configs. */
export function legacyDesktop3pAlias(provider: string, modelId: string): string {
  return `claude-opus-4-${deriveDesktop3pCode(`${provider}/${modelId}`)}`;
}

function displayModelId(modelId: string): string {
  return modelId
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === "gpt" || lower === "glm" || lower === "ai") return lower.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function collectDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<{ provider: string; id: string }>,
): { models: Desktop3pModelEntry[]; registry: Map<string, string> } {
  const registry = new Map<string, string>();
  const models: Desktop3pModelEntry[] = [];
  const candidates = [
    ...nativeSlugs.map(id => ({ provider: "native", id })),
    ...routedModels,
  ];

  for (const { provider, id } of candidates) {
    const route = `${provider}/${id}`;
    const alias = desktop3pAlias(provider, id);
    if (alias === id) {
      // Real Anthropic model: keep it OUT of the decode registry — registering it would
      // make resolveInboundModel() non-identity and kill the sk-ant native passthrough
      // (audit 133 #1). It still appears in the static Desktop model list below.
      models.push({
        name: alias,
        labelOverride: `${displayModelId(id)} (${provider})`,
        anthropicFamilyTier: "opus",
      });
      continue;
    }
    const existingRoute = registry.get(alias);
    if (existingRoute !== undefined) {
      console.warn(`[opencodex] Claude Desktop 3P alias collision: ${alias} maps to both ${existingRoute} and ${route}; skipping ${route}`);
      continue;
    }

    registry.set(alias, route);
    // Back-compat decode for Desktop configs written before the opus-4-8 rename.
    const legacy = legacyDesktop3pAlias(provider, id);
    if (!registry.has(legacy)) registry.set(legacy, route);
    models.push({
      name: alias,
      labelOverride: `${displayModelId(id)} (${provider})`,
      anthropicFamilyTier: "opus",
    });
  }

  if (models[0]) models[0].isFamilyDefault = true;
  return { models, registry };
}

/** Build and install the registry used to decode Desktop aliases. */
export function buildDesktop3pRegistry(
  nativeSlugs: string[],
  routedModels: Array<{ provider: string; id: string }>,
): Map<string, string> {
  const { registry } = collectDesktop3pModels(nativeSlugs, routedModels);
  desktop3pRegistry = registry;
  return registry;
}

/** Generate Claude Desktop 3P model entries from the proxy's available models. */
export function generateDesktop3pModels(
  nativeSlugs: string[],
  routedModels: Array<{ provider: string; id: string }>,
): Desktop3pModelEntry[] {
  const { models, registry } = collectDesktop3pModels(nativeSlugs, routedModels);
  desktop3pRegistry = registry;
  return models;
}

/** Resolve an alias using the most recently generated Desktop model registry. */
export function resolveDesktop3pAlias(alias: string): string | null {
  return desktop3pRegistry.get(alias) ?? null;
}

/**
 * Generate the complete Claude Desktop 3P gateway config.
 *
 * Default mode is "discovery": Desktop populates its picker from GET /v1/models,
 * which is the ONLY channel that can carry per-model `capabilities` (effort ladder,
 * thinking types) — the static `inferenceModels` schema has no capability fields
 * (devlog 131). "static" keeps the old pinned list (anthropicFamilyTier/isFamilyDefault)
 * for users who need tier aliases more than the effort UI.
 */
export function generateDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<{ provider: string; id: string }>,
  apiKey = "ocx",
  mode: Desktop3pConfigMode = "discovery",
): object {
  const base = {
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    inferenceGatewayApiKey: apiKey,
  };
  if (mode === "discovery") {
    // Build/refresh the decode registry even though no static list is emitted.
    buildDesktop3pRegistry(nativeSlugs, routedModels);
    return { ...base, modelDiscoveryEnabled: true };
  }
  return {
    ...base,
    modelDiscoveryEnabled: false,
    inferenceModels: generateDesktop3pModels(nativeSlugs, routedModels),
  };
}

function parseMetadata(path: string): Desktop3pMetadata {
  if (!existsSync(path)) return { entries: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Desktop3pMetadata>;
  if (!Array.isArray(parsed.entries)) throw new Error("Claude Desktop 3P _meta.json has no entries array");
  return { ...parsed, entries: parsed.entries };
}

/** Write and apply the opencodex config in Claude Desktop 3P's config library. */
export function writeDesktop3pConfig(
  port: number,
  nativeSlugs: string[],
  routedModels: Array<{ provider: string; id: string }>,
  apiKey?: string,
  mode: Desktop3pConfigMode = "discovery",
): { written: boolean; path: string; reason?: string } {
  const libraryPath = join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
  const metadataPath = join(libraryPath, "_meta.json");
  let configPath = libraryPath;

  try {
    mkdirSync(libraryPath, { recursive: true, mode: 0o700 });
    const metadata = parseMetadata(metadataPath);
    const existing = metadata.entries.find(entry => entry?.name === "opencodex" && typeof entry.id === "string");
    const id = existing?.id ?? randomUUID();
    configPath = join(libraryPath, `${id}.json`);
    const entry: Desktop3pMetadataEntry = existing ? { ...existing, id, name: "opencodex" } : { id, name: "opencodex" };
    const entries = existing
      ? metadata.entries.map(current => current === existing ? entry : current)
      : [...metadata.entries, entry];

    writeFileSync(configPath, JSON.stringify(generateDesktop3pConfig(port, nativeSlugs, routedModels, apiKey, mode), null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, appliedId: id, entries }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return { written: true, path: configPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { written: false, path: configPath, reason };
  }
}
