import type { TKey } from "../../i18n/en";
import type { LayerClass } from "../../pages/codex-set-prompt";

/**
 * Layer id -> i18n key, written out rather than built by string concatenation.
 *
 * A template like `("codexSet.layer." + id) as never` typechecks whether or not
 * the key exists, so a missing translation reaches the user as a raw key instead
 * of failing the build. These maps are `Record<..., TKey>`, which makes an absent
 * key a typecheck error - the same guarantee the locale dictionaries already have.
 */
export const LAYER_LABEL_KEYS: Record<string, TKey> = {
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
};

export const LAYER_ABOUT_KEYS: Record<string, TKey> = {
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
};

/** Only runtime-conditional rows state a condition; the rest have none to state. */
export const LAYER_CONDITION_KEYS: Record<string, TKey> = {
  "model-switch": "codexSet.condition.model-switch",
  realtime: "codexSet.condition.realtime",
  "agents-md": "codexSet.condition.agents-md",
  plugins: "codexSet.condition.plugins",
};

export const CLASS_LABEL_KEYS: Record<LayerClass, TKey> = {
  base: "codexSet.class.base",
  "config-toggle": "codexSet.class.config-toggle",
  "feature-gated": "codexSet.class.feature-gated",
  "runtime-conditional": "codexSet.class.runtime-conditional",
  "extension-unknown": "codexSet.class.extension-unknown",
};

