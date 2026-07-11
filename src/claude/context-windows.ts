/**
 * Claude-surface context-window map + effective model-env computation
 * (devlog/260712_cli_context_cache/010 B2, audit R2#1/R3#1/R3#4/R4#3).
 *
 * The map registers EVERY selector form a Claude Code model slot might store —
 * bare native slug, provider/id, desktop3p alias, legacy claude-ocx-* alias —
 * with first-wins dedupe (mirrors the desktop3p registry collision policy).
 * Values are authoritative context windows only (native override table /
 * adapter-reported CatalogModel.contextWindow); nothing is guessed.
 */
import { aliasForNative, aliasForRoute } from "./alias";
import { desktop3pAlias } from "./desktop-3p";
import { nativeOpenAiContextWindow, type CatalogModel } from "../codex/catalog";

const ONE_MILLION = 1_000_000;

export function buildClaudeContextWindows(
  nativeSlugs: readonly string[],
  routedModels: readonly CatalogModel[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string | null, value: number) => {
    if (!key) return;
    if (out[key] === undefined) out[key] = value; // first-wins (registry policy)
  };
  for (const slug of nativeSlugs) {
    const window = nativeOpenAiContextWindow(slug);
    if (typeof window !== "number" || window <= 0) continue;
    put(slug, window);
    put(desktop3pAlias("native", slug), window);
    put(aliasForNative(slug), window);
  }
  for (const m of routedModels) {
    const window = m.contextWindow;
    if (typeof window !== "number" || window <= 0) continue;
    put(`${m.provider}/${m.id}`, window);
    put(desktop3pAlias(m.provider, m.id), window);
    put(aliasForRoute(m.provider, m.id), window);
  }
  return out;
}

/** Strip a trailing [1m] marker before map lookup (selector may already carry it). */
function bareSelector(value: string): string {
  return value.endsWith("[1m]") ? value.slice(0, -4) : value;
}

/**
 * Apply the [1m] context-variant marker to a model selector when its authoritative
 * window is >= 1M (Claude Code accounts exactly 1M for the marker; compaction stays
 * alive). Already-marked selectors pass through; unknown selectors stay untouched.
 */
export function withOneMillionMarker(selector: string | undefined, windows: Record<string, number>): string | undefined {
  if (!selector) return selector;
  if (selector.endsWith("[1m]")) return selector;
  const window = windows[bareSelector(selector)];
  return typeof window === "number" && window >= ONE_MILLION ? `${selector}[1m]` : selector;
}

export interface ClaudeTierModels {
  opus?: string;
  sonnet?: string;
  haiku?: string;
  fable?: string;
}

/**
 * The exact env map Claude Code consumes for model slots (audit R4#4):
 * ANTHROPIC_MODEL + the four tier defaults + the legacy small-fast alias.
 * effective-haiku contract (audit R1#8): tierModels.haiku ?? smallFastModel, one
 * value injected into BOTH haiku variables.
 */
export function effectiveModelEnv(
  claudeCode: { model?: string; smallFastModel?: string; tierModels?: ClaudeTierModels } | undefined,
  windows: Record<string, number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    const marked = withOneMillionMarker(value, windows);
    if (marked) out[name] = marked;
  };
  set("ANTHROPIC_MODEL", claudeCode?.model);
  set("ANTHROPIC_DEFAULT_OPUS_MODEL", claudeCode?.tierModels?.opus);
  set("ANTHROPIC_DEFAULT_SONNET_MODEL", claudeCode?.tierModels?.sonnet);
  set("ANTHROPIC_DEFAULT_FABLE_MODEL", claudeCode?.tierModels?.fable);
  const effectiveHaiku = claudeCode?.tierModels?.haiku ?? claudeCode?.smallFastModel;
  set("ANTHROPIC_DEFAULT_HAIKU_MODEL", effectiveHaiku);
  set("ANTHROPIC_SMALL_FAST_MODEL", effectiveHaiku);
  return out;
}

/** Shared 3s bounded acquisition (audit R4#3) for context-window sources. */
export async function boundedContextWindows(
  acquire: () => Promise<Record<string, number>>,
  timeoutMs = 3_000,
): Promise<Record<string, number> | null> {
  try {
    return await Promise.race([
      acquire(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}
