import { isValidModelDiscoveryModelId, MODEL_DISCOVERY_MAX_MODELS } from "./model-discovery-limits";

// Google Antigravity (Cloud Code Assist) bundled model list.
//
// Single source of truth: the Antigravity `:fetchAvailableModels` backend, the same one the `agy`
// CLI resolves labels against. The ids below separate CCA wire ids, collapsed picker entries,
// and hidden compatibility aliases for saved selections. The CCA envelope's `model` field must
// receive the wire id (for example "Gemini 3.1 Pro (High)" => gemini-pro-agent), while the
// picker exposes collapsed base models only when CCA returns every known tier; otherwise each
// returned wire id remains visible so an unavailable tier cannot be selected.

// ── Wire IDs (what CCA :fetchAvailableModels returns) ──

/** Current Antigravity Flash generation. */
const GEMINI_FLASH_CURRENT = "gemini-3.7-flash";

/**
 * Retired Flash ids → the reasoning tier they used to encode.
 *
 * Google pulls the previous Flash model from CCA almost immediately when the next
 * one ships, so a saved selection cannot keep pointing at it. A flat alias would
 * strand the user's tier: `resolveAntigravityEffortWireModel` rule 1 treats any
 * alias as "the suffix IS the effort" and deliberately sends no thinkingConfig, so
 * `gemini-3.6-flash-high` would silently become an untiered 3.7 call. Carrying the
 * level here preserves what the user actually chose.
 *
 * 3.7 exposes tiers through `thinkingLevel` on ONE wire id rather than through
 * suffixed wire ids, which is why the mapping is id → level and not id → id.
 */
const RETIRED_FLASH_TIERS: Record<string, string> = {
  // 3.6 generation.
  "gemini-3.6-flash": "medium", // bare base carried a medium default
  "gemini-3.6-flash-low": "low",
  "gemini-3.6-flash-medium": "medium",
  "gemini-3.6-flash-high": "high",
  // 3.5 generation — these already pointed at 3.6 wire ids, which are now dead too.
  "gemini-3.5-flash-extra-low": "low",
  "gemini-3.5-flash-low": "medium",
  "gemini-3.5-flash-mid": "medium",
  "gemini-3.5-flash-high": "high",
  "gemini-3-flash-agent": "high",
};

const ANTIGRAVITY_WIRE_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.1-pro-low",
  "gemini-pro-agent",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

const ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID: Record<string, string> = {
  "gemini-3.1-pro-low": "gemini-3.1-pro",
  "gemini-pro-agent": "gemini-3.1-pro",
};

const ANTIGRAVITY_WIRE_IDS_BY_PICKER_MODEL: Record<string, string[]> = Object.entries(
  ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID,
).reduce<Record<string, string[]>>((out, [wireId, pickerId]) => {
  (out[pickerId] ??= []).push(wireId);
  return out;
}, {});

// ── Effort ladders per collapsed base model ──
// Gemini models: effort → wire model suffix (official agy UI pattern).
// Claude Opus: effort → thinkingConfig.thinkingLevel (CLIProxyAPI proven pattern).
export const ANTIGRAVITY_MODEL_EFFORTS: Record<string, string[]> = {
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-opus-4-6-thinking": ["low", "medium", "high", "max"],
};

// ── Effort → wire model map for Gemini base models ──
const ANTIGRAVITY_EFFORT_WIRE_MAP: Record<string, Record<string, string>> = {
  "gemini-3.1-pro": {
    low: "gemini-3.1-pro-low",
    high: "gemini-pro-agent",
  },
};

// ── Default effort per Gemini base model ──
const ANTIGRAVITY_DEFAULT_EFFORT: Record<string, string> = {
  "gemini-3.1-pro": "high",
};

/**
 * Gemini base models whose efforts ride on `thinkingLevel` against a single wire id
 * instead of suffixed wire ids, with the level applied when the caller names none.
 */
const ANTIGRAVITY_THINKING_LEVEL_MODELS: Record<string, string> = {
  "gemini-3.7-flash": "medium",
};

// `minimal` is deliberately absent: Google documents it as unsupported for the current
// Flash generation, where it is an error rather than a quieter tier.
const ANTIGRAVITY_THINKING_LEVELS = new Set(["low", "medium", "high"]);

function resolveAntigravityThinkingLevel(effort: string): string | undefined {
  if (effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
  return ANTIGRAVITY_THINKING_LEVELS.has(effort) ? effort : undefined;
}

// ── Visible client aliases (kept for saved-config compat, not picker-visible) ──
const ANTIGRAVITY_VISIBLE_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.1-pro-preview": "gemini-pro-agent",
};

// ── Hidden compatibility aliases for saved selections ──
// Wire suffix IDs are identity aliases — they resolve to themselves so saved configs
// with explicit suffixes (e.g. gemini-3.6-flash-low) continue to work.
const ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "gemini-pro-agent": "gemini-pro-agent",
  // ── Retired Flash generations ──
  // Google takes the previous Antigravity Flash model offline almost immediately
  // once its successor ships, so 3.6 (and the 3.5 ids that used to land on it)
  // route to 3.7. These stay in the alias map — not only in the tier map below —
  // because `parseAntigravityAvailableModels` uses THIS map to keep a stale CCA
  // payload from republishing a dead wire id as a picker row.
  ...Object.fromEntries(
    Object.keys(RETIRED_FLASH_TIERS).map(retired => [retired, GEMINI_FLASH_CURRENT]),
  ),
};

export const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  ...ANTIGRAVITY_VISIBLE_MODEL_ALIASES,
  ...ANTIGRAVITY_COMPATIBILITY_MODEL_ALIASES,
};

// Picker-visible: collapsed base models only.
export const ANTIGRAVITY_MODELS = [
  GEMINI_FLASH_CURRENT,
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

// Context windows from the upstream `:fetchAvailableModels` maxTokens per model.
const ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.1-pro-low": 1_048_576,
  "gemini-pro-agent": 1_048_576,
  "gemini-3.1-flash-image": 1_048_576,
  "claude-sonnet-4-6": 250_000,
  "claude-opus-4-6-thinking": 250_000,
  "gpt-oss-120b-medium": 131_072,
};

export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Collapsed base IDs — explicit entries for the picker.
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  // Wire IDs and aliases via derivation.
  ...ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS,
  ...Object.fromEntries(
    Object.entries(ANTIGRAVITY_MODEL_ALIASES).map(([alias, wire]) => [
      alias,
      ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS[wire],
    ]),
  ),
};

export const ANTIGRAVITY_MODEL_INPUT_MODALITIES: Record<string, string[]> = {
  // Google documents 3.7 Flash as also accepting video, audio and PDF, but this proxy
  // carries only text and image parts (`OcxImageContent`, src/types.ts) and the Codex
  // catalog normalizes `input_modalities` against a closed enum. Advertising a modality
  // the wire cannot carry would be a promise we break at request time.
  "gemini-3.7-flash": ["text", "image"],
  "gemini-3.1-pro": ["text", "image"],
  "gemini-3.1-flash-image": ["text", "image"],
  "claude-sonnet-4-6": ["text", "image"],
  "claude-opus-4-6-thinking": ["text", "image"],
  "gpt-oss-120b-medium": ["text"],
};

export interface AntigravityAvailableModel {
  id: string;
  contextWindow?: number;
  inputModalities?: string[];
}

function antigravityRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function antigravityPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Extract the CCA models that are valid for agent requests. The endpoint also returns tab,
 * command, commit-message, transcription, and standalone image-generation models; those are not
 * callable through the CCA agent envelope and must not be published to the Codex catalog.
 */
export function parseAntigravityAvailableModels(
  payload: unknown,
  maxModels = MODEL_DISCOVERY_MAX_MODELS,
): AntigravityAvailableModel[] | null {
  const limit = Number.isSafeInteger(maxModels) && maxModels > 0
    ? Math.min(maxModels, MODEL_DISCOVERY_MAX_MODELS)
    : MODEL_DISCOVERY_MAX_MODELS;
  const body = antigravityRecord(payload);
  if (!body) return null;
  const models = antigravityRecord(body?.models);
  const sorts = Array.isArray(body?.agentModelSorts) ? body.agentModelSorts : undefined;
  if (!models || !sorts) return null;

  const ids: string[] = [];
  for (const sort of sorts) {
    const groups = antigravityRecord(sort)?.groups;
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      const modelIds = antigravityRecord(group)?.modelIds;
      if (!Array.isArray(modelIds)) return null;
      for (const id of modelIds) {
        if (!isValidModelDiscoveryModelId(id)
          || !antigravityRecord(models[id])
          || ids.length >= limit) return null;
        ids.push(id);
      }
    }
  }
  // This model is exposed by Antigravity's agent chat surface even though it is grouped under
  // image generation in the discovery response.
  if (Array.isArray(body.imageGenerationModelIds)
    && body.imageGenerationModelIds.includes("gemini-3.1-flash-image")) {
    if (ids.length >= limit) return null;
    ids.push("gemini-3.1-flash-image");
  }

  const available = new Map<string, Record<string, unknown>>();
  for (const wireId of ids) {
    const info = antigravityRecord(models[wireId]);
    if (!info || available.has(wireId)) continue;
    // Legacy compatibility aliases are deliberately routed to newer wire ids for saved
    // selections. They are not safe as independently discovered picker rows.
    if (ANTIGRAVITY_MODEL_ALIASES[wireId] && ANTIGRAVITY_MODEL_ALIASES[wireId] !== wireId) continue;
    available.set(wireId, info);
  }

  const out: AntigravityAvailableModel[] = [];
  const seen = new Set<string>();
  for (const [wireId, info] of available) {
    const pickerId = ANTIGRAVITY_PICKER_MODEL_BY_WIRE_ID[wireId];
    const completePickerSet = pickerId !== undefined
      && ANTIGRAVITY_WIRE_IDS_BY_PICKER_MODEL[pickerId]!.every(id => available.has(id));
    const id = completePickerSet ? pickerId! : wireId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ...(antigravityPositiveInteger(info.maxTokens) ? { contextWindow: antigravityPositiveInteger(info.maxTokens) } : {}),
      inputModalities: info.supportsImages === true ? ["text", "image"] : ["text"],
    });
  }
  return out;
}

export function resolveAntigravityWireModelId(modelId: string): string {
  return ANTIGRAVITY_MODEL_ALIASES[modelId] ?? modelId;
}

/**
 * Whether the given model ID is a suffix wire ID or compat alias that already encodes
 * an effort level. For these IDs, the caller must NOT send thinkingConfig — the suffix
 * IS the effort, and sending both creates a contradictory request.
 */
export function isAntigravitySuffixModelId(modelId: string): boolean {
  return !(ANTIGRAVITY_MODELS as string[]).includes(modelId);
}

/** The reasoning tier a retired Flash id used to encode, if it is one. */
export function retiredAntigravityFlashTier(modelId: string): string | undefined {
  return RETIRED_FLASH_TIERS[modelId];
}

/**
 * Resolve a picker-visible base model + optional reasoning effort to the CCA wire model ID.
 *
 * Precedence (evaluated in order):
 * 1. Suffix wire ID or compat alias → resolve via `resolveAntigravityWireModelId`, no thinkingConfig.
 * 2. Mapped Gemini base with effort → return mapped wire ID + thinkingLevel.
 * 3. Mapped Gemini base without effort → return default-effort wire ID, no thinkingConfig.
 * 4. Claude Opus with effort → return identity + thinkingLevel (no suffix variants exist).
 * 5. All other IDs → return `resolveAntigravityWireModelId(modelId)`, no thinkingConfig.
 */
export function resolveAntigravityEffortWireModel(
  modelId: string,
  effort?: string,
): { wireModelId: string; thinkingLevel?: string } {
  // Rule 0: retired Flash id — Google has taken the wire id offline, so route to the
  // current generation and carry the tier the retired id encoded. This runs BEFORE the
  // suffix check because those ids are aliases, and rule 1 would drop the tier.
  const retiredTier = RETIRED_FLASH_TIERS[modelId];
  if (retiredTier) {
    return {
      wireModelId: GEMINI_FLASH_CURRENT,
      thinkingLevel: effort ? resolveAntigravityThinkingLevel(effort) ?? retiredTier : retiredTier,
    };
  }

  // Rule 1: suffix/compat alias — suffix IS the effort.
  if (isAntigravitySuffixModelId(modelId)) {
    return { wireModelId: resolveAntigravityWireModelId(modelId) };
  }

  // Rule 1b: single-wire-id Gemini model whose tiers ride on thinkingLevel. Without
  // this the model falls to rule 5 and silently loses reasoning control entirely.
  const defaultLevel = ANTIGRAVITY_THINKING_LEVEL_MODELS[modelId];
  if (defaultLevel) {
    return {
      wireModelId: modelId,
      thinkingLevel: effort ? resolveAntigravityThinkingLevel(effort) ?? defaultLevel : defaultLevel,
    };
  }

  // Rule 2/3: mapped Gemini base model.
  const effortMap = ANTIGRAVITY_EFFORT_WIRE_MAP[modelId];
  if (effortMap) {
    if (effort && effort in effortMap) {
      return { wireModelId: effortMap[effort]!, thinkingLevel: effort };
    }
    const defaultEffort = ANTIGRAVITY_DEFAULT_EFFORT[modelId]!;
    return { wireModelId: effortMap[defaultEffort]! };
  }

  // Rule 4: Claude models — effort via thinkingConfig only (no suffix variants).
  // CCA validates this field as Google's ThinkingLevel enum, whose highest value is `high`.
  if (/^claude-/.test(modelId) && effort) {
    return { wireModelId: modelId, thinkingLevel: resolveAntigravityThinkingLevel(effort) };
  }

  // Rule 5: everything else.
  return { wireModelId: resolveAntigravityWireModelId(modelId) };
}


// ── Usage aggregation reverse map (picker/call base identity) ──
// Effort wire IDs and compatibility aliases must collapse to the same picker-visible
// base model that users invoke after effort routing. Historical logs store suffix IDs;
// summary aggregation consults this reverse map so one call model = one usage row.
const ANTIGRAVITY_USAGE_BASE_BY_ID: Record<string, string> = (() => {
  const rev: Record<string, string> = {};
  for (const base of ANTIGRAVITY_MODELS) rev[base] = base;
  for (const [base, effortMap] of Object.entries(ANTIGRAVITY_EFFORT_WIRE_MAP)) {
    rev[base] = base;
    for (const wire of Object.values(effortMap)) rev[wire] = base;
  }
  for (const [alias, wire] of Object.entries(ANTIGRAVITY_MODEL_ALIASES)) {
    const base = rev[wire] ?? rev[alias];
    if (base) rev[alias] = base;
    // If alias is itself a base/wire already mapped, keep that mapping.
    else if (rev[wire]) rev[alias] = rev[wire]!;
  }
  // Retired ids keep their OWN identity for usage aggregation, overriding the alias
  // pass above. Routing sends new 3.6 calls to 3.7, but a usage row written months ago
  // records a model the user actually called: relabelling it would move historical spend
  // onto a model that did not exist then, and away from the 3.6 price row that still
  // prices it correctly. Retirement changes what we CALL, not what we RECORD.
  for (const retired of Object.keys(RETIRED_FLASH_TIERS)) rev[retired] = retired;
  // Visible aliases that only appear in ANTIGRAVITY_VISIBLE_MODEL_ALIASES are already
  // included via ANTIGRAVITY_MODEL_ALIASES. Identity bases without effort maps remain.
  return rev;
})();

/**
 * Canonical picker/call model id for usage aggregation.
 * Unknown ids stay identity so future CCA models do not invent mappings.
 */
export function canonicalAntigravityUsageModel(modelId: string): string {
  const id = modelId.trim();
  if (!id) return modelId;
  return ANTIGRAVITY_USAGE_BASE_BY_ID[id] ?? id;
}
