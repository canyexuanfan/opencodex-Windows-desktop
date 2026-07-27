"use strict";

/**
 * Conventional-commit title → GitHub type label for PR Labeler.
 * Kept as a pure module so override behavior can be unit-tested without Actions.
 */

const PREFIX_TO_LABEL = Object.freeze({
  feat: "enhancement",
  feature: "enhancement",
  fix: "bug",
  bugfix: "bug",
  hotfix: "bug",
  docs: "documentation",
  doc: "documentation",
  chore: "chore",
  refactor: "chore",
  style: "chore",
  test: "chore",
  tests: "chore",
  ci: "chore",
  build: "chore",
  perf: "enhancement",
  revert: "chore",
});

const TYPE_LABELS = new Set(Object.values(PREFIX_TO_LABEL));

/** Actors whose type-label mutations are treated as bot-owned (may be overwritten). */
const BOT_ACTORS = new Set(["github-actions[bot]"]);

/**
 * Map a conventional-commit PR title to a managed type label.
 * @param {string} title
 * @returns {string|null}
 */
function detectTypeLabelFromTitle(title) {
  const match = String(title || "").match(/^([a-zA-Z]+)(?:\([^)]*\))?[!]?\s*:/);
  if (!match) return null;
  return PREFIX_TO_LABEL[match[1].toLowerCase()] || null;
}

/**
 * True when a human (any non-bot actor) has ever labeled or unlabeled a managed
 * type label on this PR. Mirrors issue-quality's sticky maintainerOverride:
 * once a person changes the bot's choice, later synchronize/edited runs must
 * not revert it.
 *
 * @param {Array<{ event?: string, label?: { name?: string }, actor?: { login?: string } }>} events
 * @param {Set<string>} [typeLabels]
 * @param {Set<string>} [botActors]
 * @returns {boolean}
 */
function hasHumanTypeLabelOverride(events, typeLabels = TYPE_LABELS, botActors = BOT_ACTORS) {
  if (!Array.isArray(events)) return false;
  for (const event of events) {
    if (event?.event !== "labeled" && event?.event !== "unlabeled") continue;
    const name = event.label?.name;
    if (!name || !typeLabels.has(name)) continue;
    const actor = event.actor?.login;
    if (actor && !botActors.has(actor)) return true;
  }
  return false;
}

/**
 * Plan type-label add/remove mutations for a PR.
 *
 * @param {{
 *   title: string,
 *   currentLabels: string[],
 *   events: Array<{ event?: string, label?: { name?: string }, actor?: { login?: string } }>,
 * }} input
 * @returns {{
 *   skip: true,
 *   reason: "human-override" | "no-prefix",
 * } | {
 *   skip: false,
 *   detected: string,
 *   add: string|null,
 *   remove: string[],
 * }}
 */
function planTypeLabelSync(input) {
  const title = input?.title ?? "";
  const currentLabels = Array.isArray(input?.currentLabels) ? input.currentLabels : [];
  const events = Array.isArray(input?.events) ? input.events : [];

  if (hasHumanTypeLabelOverride(events)) {
    return { skip: true, reason: "human-override" };
  }

  const detected = detectTypeLabelFromTitle(title);
  if (!detected) {
    return { skip: true, reason: "no-prefix" };
  }

  const current = new Set(currentLabels);
  const remove = [...TYPE_LABELS].filter((label) => current.has(label) && label !== detected);
  const add = current.has(detected) ? null : detected;
  return { skip: false, detected, add, remove };
}

module.exports = {
  PREFIX_TO_LABEL,
  TYPE_LABELS,
  BOT_ACTORS,
  detectTypeLabelFromTitle,
  hasHumanTypeLabelOverride,
  planTypeLabelSync,
};
