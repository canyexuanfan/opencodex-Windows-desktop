import type { TKey } from "../../i18n/en";
import type { LayerClass } from "../../pages/codex-set-prompt";

/**
 * Every layer id in LAYER_INVENTORY, as a finite union.
 *
 * This is what makes the maps below exhaustive. `Record<string, TKey>` does NOT:
 * `string` has no required members, so deleting an entry typechecks cleanly and
 * the non-null assertion at the call site hides the missing lookup until a user
 * sees a blank row. A union has required members, so a gap is a build failure.
 */
export type LayerId =
  | "base-instructions"
  | "model-switch"
  | "personality"
  | "context-window-guidance"
  | "realtime"
  | "agents-md"
  | "permissions"
  | "collaboration"
  | "environment"
  | "environments-instructions"
  | "apps"
  | "plugins"
  | "tools"
  | "skills"
  | "multi-agent-mode"
  | "git-attribution";

/**
 * Layer id -> i18n key, written out rather than built by string concatenation.
 *
 * A template like `("codexSet.layer." + id) as never` typechecks whether or not
 * the key exists, so a missing translation reaches the user as a raw key instead
 * of failing the build.
 */
export const LAYER_LABEL_KEYS: Record<LayerId, TKey> = {
  "base-instructions": "codexSet.layer.base-instructions",
  "model-switch": "codexSet.layer.model-switch",
  personality: "codexSet.layer.personality",
  "context-window-guidance": "codexSet.layer.context-window-guidance",
  realtime: "codexSet.layer.realtime",
  "agents-md": "codexSet.layer.agents-md",
  permissions: "codexSet.layer.permissions",
  collaboration: "codexSet.layer.collaboration",
  environment: "codexSet.layer.environment",
  "environments-instructions": "codexSet.layer.environments-instructions",
  apps: "codexSet.layer.apps",
  plugins: "codexSet.layer.plugins",
  tools: "codexSet.layer.tools",
  skills: "codexSet.layer.skills",
  "multi-agent-mode": "codexSet.layer.multi-agent-mode",
  "git-attribution": "codexSet.layer.git-attribution",
};

export const LAYER_ABOUT_KEYS: Record<LayerId, TKey> = {
  "base-instructions": "codexSet.about.base-instructions",
  "model-switch": "codexSet.about.model-switch",
  personality: "codexSet.about.personality",
  "context-window-guidance": "codexSet.about.context-window-guidance",
  realtime: "codexSet.about.realtime",
  "agents-md": "codexSet.about.agents-md",
  permissions: "codexSet.about.permissions",
  collaboration: "codexSet.about.collaboration",
  environment: "codexSet.about.environment",
  "environments-instructions": "codexSet.about.environments-instructions",
  apps: "codexSet.about.apps",
  plugins: "codexSet.about.plugins",
  tools: "codexSet.about.tools",
  skills: "codexSet.about.skills",
  "multi-agent-mode": "codexSet.about.multi-agent-mode",
  "git-attribution": "codexSet.about.git-attribution",
};

/**
 * Only runtime-conditional rows state a condition, so this map is deliberately
 * PARTIAL - a Partial<Record<LayerId, TKey>> rather than a total one, because
 * requiring an entry for every layer would mean inventing conditions that do not
 * exist.
 */
export const LAYER_CONDITION_KEYS: Partial<Record<LayerId, TKey>> = {
  "model-switch": "codexSet.condition.model-switch",
  realtime: "codexSet.condition.realtime",
  "agents-md": "codexSet.condition.agents-md",
  plugins: "codexSet.condition.plugins",
  // Mandatory for this row, not optional: without it the renderer falls through to
  // "always on", and that is false - the account can turn attribution off, in which
  // case Codex sends the opposite instruction rather than sending nothing.
  "git-attribution": "codexSet.condition.git-attribution",
};

export const CLASS_LABEL_KEYS: Record<LayerClass, TKey> = {
  base: "codexSet.class.base",
  "config-toggle": "codexSet.class.config-toggle",
  "feature-gated": "codexSet.class.feature-gated",
  "runtime-conditional": "codexSet.class.runtime-conditional",
  "extension-unknown": "codexSet.class.extension-unknown",
};
