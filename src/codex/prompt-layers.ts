/**
 * prompt-layers.ts — the Codex prompt-layer surface in `$CODEX_HOME/config.toml`.
 *
 * Scope boundary: this module owns the five `include_*` prompt toggles and the
 * generated `developer_instructions` projection. It is a SIBLING of
 * `features.ts`, not an extension of it: that module's header explicitly forbids
 * broadening itself past `multi_agent_v2`, so the technique is copied here
 * rather than the file being widened.
 *
 * Two design decisions are load-bearing and were forced by an adversarial audit
 * (devlog/_plan/260802_codex_set_prompt_composer/):
 *
 * 1. NO USER PROSE IS PARSED BACK OUT OF TOML. Custom layers live in
 *    `opencodex-prompt.json`, which we own outright; config.toml receives a
 *    write-only projection of the enabled subset. Layer identity never has to
 *    survive a round trip through a TOML parser.
 *
 * 2. NO TOML LIBRARY IS USED TO VERIFY WHAT WE WROTE. Measured on Bun 1.3.14,
 *    `Bun.TOML.parse` transposes `\t` and `\f`, rejects `\u0007`, and does not
 *    trim the newline after an opening `'''`. Codex parses with Rust
 *    `toml_edit`, so verifying through a JS parser could report success on a
 *    file Codex reads differently. Instead the accepted character set is
 *    restricted until escaping is total under three rules, and verification is
 *    a byte comparison.
 *
 * CODEX_HOME is resolved at CALL time (the `features.ts:58-67` pattern) so tests
 * can point fixtures via env or an explicit path.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expandUserPath } from "../config";
import { CODEX_CONFIG_PATH } from "./paths";
import { OCX_SECTION_MARKER } from "./injected-marker";

// ---------------------------------------------------------------------------
// Inventory — ONE definition, consumed by the route and the GUI alike.
// Classes are the five in devlog 001 §4; the partition is total and disjoint.
// ---------------------------------------------------------------------------

export type LayerClass =
  | "base"
  | "config-toggle"
  | "feature-gated"
  | "runtime-conditional"
  | "extension-unknown";

export type ToggleId =
  | "permissions"
  | "collaboration"
  | "environment"
  | "apps"
  | "skills";

export interface LayerDescriptor {
  id: string;
  class: LayerClass;
  /** config key for config-toggle and feature-gated rows; null otherwise */
  key: string | null;
  /** documented default when the key is absent */
  default: boolean | null;
  /** assembly index from devlog 001 §1; null when registration-order dependent */
  order: number | null;
}

/**
 * Assembly order per `core/src/session/world_state.rs`. `base-instructions` is
 * NOT a world-state section — it travels in the Responses `instructions` field
 * — so it carries order 0 and sits ahead of the rest.
 *
 * `plugins` is `runtime-conditional`, not feature-gated: `core/src/mcp.rs:200`
 * computes `selected_plugin_available || !capability_summaries().is_empty()`,
 * so `[features] plugins` influences the right operand but does not gate
 * emission.
 */
export const LAYER_INVENTORY: readonly LayerDescriptor[] = Object.freeze([
  { id: "base-instructions", class: "base", key: null, default: null, order: 0 },
  { id: "model-switch", class: "runtime-conditional", key: null, default: null, order: 1 },
  { id: "personality", class: "feature-gated", key: "features.personality", default: true, order: 2 },
  { id: "context-window-guidance", class: "feature-gated", key: "features.token_budget", default: false, order: 3 },
  { id: "realtime", class: "runtime-conditional", key: null, default: null, order: 4 },
  { id: "agents-md", class: "runtime-conditional", key: null, default: null, order: 5 },
  { id: "permissions", class: "config-toggle", key: "include_permissions_instructions", default: true, order: 6 },
  { id: "collaboration", class: "config-toggle", key: "include_collaboration_mode_instructions", default: true, order: 7 },
  { id: "environment", class: "config-toggle", key: "include_environment_context", default: true, order: 8 },
  { id: "environments-instructions", class: "feature-gated", key: "features.deferred_executor", default: false, order: 9 },
  { id: "apps", class: "config-toggle", key: "include_apps_instructions", default: true, order: 10 },
  { id: "plugins", class: "runtime-conditional", key: null, default: null, order: 11 },
  { id: "tools", class: "feature-gated", key: "features.deferred_tool_world_state", default: false, order: 12 },
  { id: "skills", class: "config-toggle", key: "skills.include_instructions", default: true, order: 13 },
  { id: "multi-agent-mode", class: "feature-gated", key: "features.multi_agent_v2.enabled", default: false, order: 14 },
] as const);

/**
 * The write allowlist. Fixed, never computed: `config_toml.rs` does NOT carry
 * serde's `deny_unknown_fields`, so a typo'd key is silently ignored in normal
 * mode and a hard startup error under `--strict-config`. A fixed table means
 * the GUI can never emit a key it did not intend.
 */
const TOGGLE_KEYS: Record<ToggleId, { table: string | null; key: string }> = {
  permissions: { table: null, key: "include_permissions_instructions" },
  collaboration: { table: null, key: "include_collaboration_mode_instructions" },
  environment: { table: null, key: "include_environment_context" },
  apps: { table: null, key: "include_apps_instructions" },
  skills: { table: "skills", key: "include_instructions" },
};

export const TOGGLE_IDS = Object.freeze(Object.keys(TOGGLE_KEYS) as ToggleId[]);

export function isToggleId(value: string): value is ToggleId {
  return Object.prototype.hasOwnProperty.call(TOGGLE_KEYS, value);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface Paths {
  configPath?: string;
  storePath?: string;
}

function activeCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return CODEX_CONFIG_PATH.slice(0, -"/config.toml".length);
  const path = resolve(expandUserPath(raw));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function activeConfigPath(opts?: Paths): string {
  return opts?.configPath ?? join(activeCodexHome(), "config.toml");
}

export function activeStorePath(opts?: Paths): string {
  return opts?.storePath ?? join(activeCodexHome(), "opencodex-prompt.json");
}

// ---------------------------------------------------------------------------
// Character policy — see the header. Defined over Unicode SCALAR VALUES, not
// UTF-16 code units, because a lone surrogate is not a scalar value and UTF-8
// encoding would silently substitute U+FFFD.
// ---------------------------------------------------------------------------

export interface CharacterFinding {
  /** code-point index, consistent across module, route and editor */
  position: number;
  reason: "control" | "unpaired-surrogate";
  codePoint: number;
}

/** Tab to four spaces, CRLF and lone CR to LF. Applied BEFORE validation. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

/** First offending scalar, or null. Run AFTER normalizeBody. */
export function findInvalidCharacter(body: string): CharacterFinding | null {
  let position = 0;
  for (let i = 0; i < body.length; ) {
    const code = body.codePointAt(i)!;
    const unit = body.charCodeAt(i);
    const isHighSurrogate = unit >= 0xd800 && unit <= 0xdbff;
    const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
    // codePointAt only combines a well-formed pair, so a surviving surrogate
    // code point here is unpaired by construction.
    if ((isHighSurrogate || isLowSurrogate) && code === unit) {
      return { position, reason: "unpaired-surrogate", codePoint: code };
    }
    const isNewline = code === 0x0a;
    const isC0 = code < 0x20 && !isNewline;
    const isDel = code === 0x7f;
    const isC1 = code >= 0x80 && code <= 0x9f;
    if (isC0 || isDel || isC1) {
      return { position, reason: "control", codePoint: code };
    }
    i += code > 0xffff ? 2 : 1;
    position += 1;
  }
  return null;
}

/**
 * TOML basic-string encoding, total over the accepted set: three rules, none of
 * them in the range where `Bun.TOML.parse` misbehaves. `\r` cannot appear
 * because normalizeBody removed it; control characters cannot appear because
 * findInvalidCharacter rejected them.
 */
export function encodeBasicString(body: string): string {
  return `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Inverse of `encodeBasicString`, deliberately narrow: it accepts ONLY the three
 * escapes we emit. `\t`, `\f`, `\b`, `\r` and `\uXXXX` are refused rather than
 * guessed — decoding them correctly is exactly the ambiguity the restricted set
 * exists to avoid.
 */
export function decodeBasicString(literal: string): string | null {
  if (literal.length < 2 || !literal.startsWith('"') || !literal.endsWith('"')) return null;
  const inner = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      if (ch === '"') return null; // unescaped quote: not a single literal
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "n") out += "\n";
    else return null; // any other escape is outside what we will decode
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Byte-level hashing. The revision covers COMPLETE file bytes plus existence,
// so removing the marker while leaving the value intact still changes it.
// ---------------------------------------------------------------------------

function readFileOrNull(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function computeRevision(configBytes: string | null, storeBytes: string | null): string {
  const hash = createHash("sha256");
  hash.update("cfg:");
  hash.update(configBytes ?? "\0absent");
  hash.update("\nstore:");
  hash.update(storeBytes ?? "\0absent");
  return `sha256:${hash.digest("hex")}`;
}

export { readFileOrNull as readFileBytes };
