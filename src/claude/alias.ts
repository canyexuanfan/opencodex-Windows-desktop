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
 *  - model ids containing `/` are not aliased (would be ambiguous on resolve);
 *  - model ids MAY contain `--` (resolve splits on the FIRST `--` only);
 *  - native OpenAI slugs use the pseudo-provider `native` and resolve back to
 *    the bare slug; a real provider named "native" is therefore never aliased.
 */

export const CLAUDE_ALIAS_PREFIX = "claude-ocx-";
const NATIVE_PSEUDO_PROVIDER = "native";

/** Alias for a routed "<provider>/<model>" pair; null when not representable. */
export function aliasForRoute(provider: string, modelId: string): string | null {
  if (!provider || provider.includes("--") || provider.includes("/") || provider === NATIVE_PSEUDO_PROVIDER) return null;
  if (!modelId || modelId.includes("/")) return null;
  return `${CLAUDE_ALIAS_PREFIX}${provider}--${modelId}`;
}

/** Alias for a native OpenAI slug (bare model id, no provider namespace). */
export function aliasForNative(slug: string): string | null {
  if (!slug || slug.includes("/") || slug.includes("--")) return null;
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
  const model = rest.slice(sep + 2);
  if (!model) return null;
  return provider === NATIVE_PSEUDO_PROVIDER ? model : `${provider}/${model}`;
}
