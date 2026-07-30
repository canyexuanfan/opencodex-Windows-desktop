/**
 * Gateway model-discovery aliases (devlog/260711_claude_inbound/020, 003 G1-G6).
 *
 * Claude Code's /model picker only lists discovery entries whose id literally
 * begins with `claude` or `anthropic`, so routed models are exposed as
 * `claude-ocx-<provider>--<model>` with an honest display_name. Aliases must be
 * deterministic, reversible, and STABLE across releases (picker selections
 * persist to Claude Code's settings.json `model` field).
 *
 * Reversibility rules:
 *  - providers containing `--` or `/` are not aliased (split boundary safety);
 *  - model ids MAY contain `/` — encoded as `~` so the alias stays slash-free
 *    for Claude Code's picker (e.g. openrouter `anthropic/claude-opus-4-8` →
 *    `claude-ocx-openrouter--anthropic~claude-opus-4-8`);
 *  - model ids that already contain `~` are not aliased (encode collision);
 *  - model ids MAY contain `--` (resolve splits on the FIRST `--` only);
 *  - native OpenAI slugs use the pseudo-provider `native` and resolve back to
 *    the bare slug; a real provider named "native" is therefore never aliased.
 */

import { desktop3pAlias } from "./desktop-3p";

export const CLAUDE_ALIAS_PREFIX = "claude-ocx-";
/** Stand-in for "/" inside the model portion of a Claude Code alias. */
const CLAUDE_ALIAS_SLASH_ENC = "~";
const NATIVE_PSEUDO_PROVIDER = "native";

function encodeModelId(modelId: string): string | null {
  if (modelId.includes(CLAUDE_ALIAS_SLASH_ENC)) return null;
  return modelId.replaceAll("/", CLAUDE_ALIAS_SLASH_ENC);
}

function decodeModelId(encoded: string): string {
  return encoded.replaceAll(CLAUDE_ALIAS_SLASH_ENC, "/");
}

/** Alias for a routed "<provider>/<model>" pair; null when not representable. */
export function aliasForRoute(provider: string, modelId: string): string | null {
  if (!provider || provider.includes("--") || provider.includes("/") || provider === NATIVE_PSEUDO_PROVIDER) return null;
  if (!modelId) return null;
  const encoded = encodeModelId(modelId);
  if (encoded === null) return null;
  return `${CLAUDE_ALIAS_PREFIX}${provider}--${encoded}`;
}

/** Alias for a native OpenAI slug (bare model id, no provider namespace). */
export function aliasForNative(slug: string): string | null {
  // Reject "/" and "~" — "~" is the slash stand-in; allowing it would round-trip wrong via decodeModelId.
  if (!slug || slug.includes("/") || slug.includes("--") || slug.includes(CLAUDE_ALIAS_SLASH_ENC)) return null;
  return `${CLAUDE_ALIAS_PREFIX}${NATIVE_PSEUDO_PROVIDER}--${slug}`;
}

/**
 * Reverse an alias to the inbound model string routeModel understands:
 * routed -> "<provider>/<model>", native -> bare slug. Null when not an alias.
 */
export function resolveAlias(id: string): string | null {
  if (!id.startsWith(CLAUDE_ALIAS_PREFIX)) return null;
  const rest = id.slice(CLAUDE_ALIAS_PREFIX.length);
  const sep = rest.indexOf("--");
  if (sep <= 0) return null;
  const provider = rest.slice(0, sep);
  const model = decodeModelId(rest.slice(sep + 2));
  if (!model) return null;
  return provider === NATIVE_PSEUDO_PROVIDER ? model : `${provider}/${model}`;
}

/**
 * Claude Code (CLI) surface alias — devlog 050 + audit 051 #2.
 *
 * The readable `claude-ocx-*` form when representable; otherwise the desktop-3p
 * hash so the model still appears in discovery (collisions follow the same
 * first-wins policy as the desktop registry — audit 051 #1). Real Anthropic
 * models pass through unchanged (they must keep hitting the sk-ant passthrough).
 * Both families keep decoding forever in resolveInboundModel, so ids persisted
 * in Claude Code's settings.json never break when the surface style changes.
 */
export function claudeCodeAlias(provider: string, modelId: string): string {
  if (provider === "anthropic" && modelId.startsWith("claude-")) return modelId;
  return aliasForRoute(provider, modelId) ?? desktop3pAlias(provider, modelId);
}

/** Claude Code (CLI) surface alias for a native OpenAI slug. */
export function claudeCodeNativeAlias(slug: string): string {
  return aliasForNative(slug) ?? desktop3pAlias("native", slug);
}
