/**
 * Heuristic token-estimation sidecar.
 *
 * Some providers (notably kiro / CodeWhisperer) return no token usage in their stream, so Codex's
 * usage display and auto-compact (which read response.completed.usage) never engage. This module
 * provides a cheap, dependency-free char-based estimate to fill that gap.
 *
 * Grounding (web): 1 token ~= 4 chars for English prose; empirical model ratios are ~Claude 3.5,
 * ~GPT 3.6, ~Gemini 3.8 chars/token (within ~10%). Code / JSON / tool-args (the dominant Codex
 * traffic) pack MORE tokens per char, so a lower chars-per-token ratio is used for those models.
 * Over-counting fails safe (auto-compact fires earlier); under-counting risks context overflow.
 */

/** Generic English-prose fallback ratio (chars per token). */
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Kiro routes code/JSON-heavy agent traffic whose true ratio is ~3.0-3.3 chars/token. 3.5 keeps a
 * small safety margin (slight over-count) without wildly inflating; tune toward 3.3 if overflow is
 * ever observed. All kiro models are text LLMs, so a single ratio applies to the whole family.
 */
const KIRO_CHARS_PER_TOKEN = 3.5;

const KIRO_MODEL_PREFIXES = ["kiro", "claude", "deepseek", "minimax", "glm", "qwen"];

/** Model-aware chars-per-token ratio. Unknown models fall back to the generic English ratio. */
export function charsPerToken(modelId?: string): number {
  if (!modelId) return DEFAULT_CHARS_PER_TOKEN;
  const id = modelId.toLowerCase();
  if (KIRO_MODEL_PREFIXES.some(p => id.startsWith(p))) return KIRO_CHARS_PER_TOKEN;
  return DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Estimate the token count of a text blob. Pure and deterministic.
 * Returns 0 for empty/whitespace-free-empty input; otherwise ceil(length / ratio), min 1.
 */
export function estimateTokens(text: string, modelId?: string): number {
  if (!text) return 0;
  const len = text.length;
  if (len === 0) return 0;
  return Math.max(1, Math.ceil(len / charsPerToken(modelId)));
}
