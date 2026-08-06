"use strict";

/** Regex that finds the enforcer state marker inside a bot comment body. */
const STATE_PATTERN =
  /<!-- (?:wrong-branch-enforcer|pr-quality-enforcer)-state:([\s\S]*?) -->/;
/** Regex that finds the readiness state marker inside a bot comment body. */
const READINESS_STATE_PATTERN =
  /<!-- pr-quality-readiness-state:([\s\S]*?) -->/;
/**
 * Regex that finds the consolidated gate state marker. This is the only state
 * marker the gate writes after the migration; the two legacy patterns above
 * are read only to migrate pre-consolidation PRs.
 */
const GATE_STATE_PATTERN =
  /<!-- opencodex-pr-gate-state:([\s\S]*?) -->/;

/**
 * v2 adds `completedAtHeadSha` so a completed checklist is bound to the exact
 * head it attested. v1 states (no field) are read the same way: the binding
 * only starts on the next completion.
 */
const READINESS_STATE_VERSION = 2;

/** A completed checklist may attest "on the latest dev" while the head is up to
 * this many commits behind the base. Beyond it the box no longer holds. */
const READINESS_LATEST_DEV_BEHIND_MAX = 10;

/** Parse the enforcer state marker, or `null` when absent or unreadable. */
function parseState(body, warn = () => {}) {
  const match = body?.match(STATE_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    warn(`Could not parse stored workflow state: ${error.message}`);

    return null;
  }
}

/** Serialize the enforcer state into its comment marker. */
function stateMarker(state) {
  return (
    "<!-- pr-quality-enforcer-state:" +
    JSON.stringify(state) +
    " -->"
  );
}

/** Parse the readiness state marker, or `null` when absent or unreadable. */
function parseReadinessState(body, warn = () => {}) {
  const match = body?.match(READINESS_STATE_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    warn(`Could not parse stored readiness state: ${error.message}`);

    return null;
  }
}

/** Serialize the readiness state into its comment marker. */
function readinessStateMarker(state) {
  return (
    "<!-- pr-quality-readiness-state:" +
    JSON.stringify(state) +
    " -->"
  );
}

/**
 * Parse the consolidated gate state marker, or `null` when absent or
 * unreadable.
 */
function parseGateState(body, warn = () => {}) {
  const match = body?.match(GATE_STATE_PATTERN);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    warn(`Could not parse stored gate state: ${error.message}`);

    return null;
  }
}

/** Serialize the consolidated gate state into its comment marker. */
function gateStateMarker(state) {
  return (
    "<!-- opencodex-pr-gate-state:" +
    JSON.stringify(state) +
    " -->"
  );
}

/**
 * Fresh consolidated gate state. It merges the old enforcer ownership fields
 * (active / autoDraftedByBot / titlePrefixedByBot) with the readiness fields
 * (maintainersPinged / completedAtHeadSha). `reviewReadyLabeled` records
 * whether the gate currently owns the `review-ready` label, so a run that
 * merely re-renders the comment does not re-fire the label webhook.
 */
function defaultGateState() {
  return {
    version: 1,
    active: false,
    autoDraftedByBot: false,
    titlePrefixedByBot: false,
    maintainersPinged: false,
    completedAtHeadSha: null,
    reviewReadyLabeled: false
  };
}

/** The enforcer comment state after every quality gate clears. */
function clearedEnforcerState() {
  return {
    version: 1,
    active: false,
    autoDraftedByBot: false,
    titlePrefixedByBot: false,
    ancestryFailed: false,
    descriptionFailed: false,
    screenshotFailed: false
  };
}

/** Fresh enforcer state for a run that must draft the PR. */
function defaultEnforcerState() {
  return {
    version: 1,
    active: true,
    autoDraftedByBot: false,
    titlePrefixedByBot: false,
    ancestryFailed: false,
    descriptionFailed: false,
    screenshotFailed: false
  };
}

/** Fresh checklist-message state for a contributor PR. */
function defaultReadinessState() {
  return {
    version: READINESS_STATE_VERSION,
    autoDraftedByBot: false,
    maintainersPinged: false,
    completedAtHeadSha: null
  };
}

/**
 * Migrate a pre-consolidation PR: merge the legacy enforcer and readiness
 * states into the consolidated gate state. The legacy states are read from the
 * two old bot comments; either may be absent (null). State fields are read
 * for truthiness (not strict type), matching how the pre-consolidation gate
 * read them — a legacy marker carrying `"active":"true"` still restores.
 */
function migrateLegacyGateState(enforcerState, readinessState) {
  const gate = defaultGateState();
  if (enforcerState) {
    gate.active = Boolean(enforcerState.active);
    gate.autoDraftedByBot = Boolean(enforcerState.autoDraftedByBot);
    gate.titlePrefixedByBot = Boolean(enforcerState.titlePrefixedByBot);
  }
  if (readinessState) {
    gate.autoDraftedByBot = Boolean(readinessState.autoDraftedByBot);
    gate.maintainersPinged = Boolean(readinessState.maintainersPinged);
    gate.completedAtHeadSha = readinessState.completedAtHeadSha ?? null;
  }
  return gate;
}

/**
 * A completed checklist is an attestation about a specific head. The
 * attestation is stale when the recorded completion head differs from the
 * live head (new commits landed after the last completion) or when the boxes
 * were ticked in an event that saw an older head than the live one — a push
 * raced the `edited` job, so no completion head was recorded yet but the
 * ticks predate the code under review — or when a synchronize event sees a
 * complete checklist with no recorded head at all (the completion job may
 * still be queued for an older head).
 */

/**
 * Bot-side verification of the two checklist claims the gate can check itself.
 * The CI box only holds when the head's `ci` check is green, and the
 * latest-dev box only holds while the head is at most
 * READINESS_LATEST_DEV_BEHIND_MAX commits behind the base. Unknown state
 * (compare or checks lookup failed) fails closed: an unverifiable claim is a
 * violation, because an attestation must not ride on missing evidence.
 */
function readinessClaimViolations({
  ciGreen,
  behindBase,
  behindUnknown = false,
  behindMax = READINESS_LATEST_DEV_BEHIND_MAX
}) {
  const violations = [];
  if (!ciGreen) {
    violations.push("ci_green");
  }
  if (behindUnknown || behindBase > behindMax) {
    violations.push("latest_dev");
  }
  return violations;
}

/**
 * The review bots whose findings threads the gate can verify. Codex posts
 * under the ChatGPT Codex Connector app; CodeRabbit under coderabbitai. Both
 * attach inline findings as pull-request review threads.
 */
const REVIEW_FINDINGS_BOT_LOGINS = [
  "chatgpt-codex-connector[bot]",
  "coderabbitai[bot]"
];

/**
 * CodeRabbit's review-body line that reports actionable inline findings. The
 * gate reads this to count findings that CodeRabbit posts only as review-body
 * text ("outside the diff range") rather than as inline review threads.
 */
const CODE_RABBIT_ACTIONABLE_RE =
  /\*\*Actionable comments posted:\s*(\d+)\*\*/i;

/**
 * Pull-request reviews (from `pulls.listReviews`) that carry CodeRabbit
 * findings. CodeRabbit posts some findings that cannot be attached inline
 * ("outside the diff range") in the review body with the line
 * `**Actionable comments posted: N**`; those never become review threads, so
 * the thread check alone would miss them. This supplements the thread check:
 * a CodeRabbit review of the live head whose body reports actionable comments
 * counts as an unresolved finding.
 *
 * Only the most recent review for the live head is considered (the head a
 * findings-review covers is the head that must be clean), so an older review
 * of a superseded commit cannot keep the box unticked forever.
 */
function coderabbitOutsideDiffFindings({ reviews = [], liveHeadSha }) {
  if (!liveHeadSha || !Array.isArray(reviews) || reviews.length === 0) {
    return { code: null, unresolved: 0, byBot: {} };
  }
  const latestForHead = reviews
    .filter(review => review?.commit_id === liveHeadSha)
    .sort(
      (a, b) =>
        Date.parse(String(b?.submitted_at ?? "")) -
        Date.parse(String(a?.submitted_at ?? ""))
    )[0];
  const body = String(latestForHead?.body ?? "");
  const match = CODE_RABBIT_ACTIONABLE_RE.exec(body);
  if (!match) return { code: null, unresolved: 0, byBot: {} };
  const count = Number(match[1]);
  if (!(count > 0)) return { code: null, unresolved: 0, byBot: {} };
  return {
    code: "review_findings",
    unresolved: count,
    byBot: { "coderabbitai[bot]": count }
  };
}

/**
 * Verify the Codex/CodeRabbit findings claim. The primary signal is the
 * pull-request review threads the GraphQL `pullRequestReviewThreads` query
 * returns: a thread authored by a review bot that is not explicitly resolved
 * is an unresolved finding. CodeRabbit additionally reports some findings
 * only in its review body (outside the diff range); those are added by the
 * `coderabbitOutsideDiffFindings` supplement so they cannot slip through.
 * The supplement is subordinate: it never subtracts, only adds unresolved
 * counts for the live head, and once the reviewer resolves the threads the
 * next run re-checks.
 */
function unresolvedFindingsClaim({ threads = [], reviews = [], liveHeadSha }) {
  const byBot = {};
  let unresolved = 0;
  for (const thread of threads) {
    const login = thread?.author?.login;
    if (!REVIEW_FINDINGS_BOT_LOGINS.includes(login)) continue;
    if (thread.isResolved !== true) {
      byBot[login] = (byBot[login] ?? 0) + 1;
      unresolved += 1;
    }
  }
  const outside = coderabbitOutsideDiffFindings({ reviews, liveHeadSha });
  if (outside.code) {
    for (const [login, count] of Object.entries(outside.byBot)) {
      byBot[login] = (byBot[login] ?? 0) + count;
      unresolved += count;
    }
  }
  return unresolved > 0
    ? { code: "review_findings", unresolved, byBot }
    : { code: null, unresolved: 0, byBot };
}

function completionIsStale({
  checklistRequired,
  checklistComplete,
  readinessPresent,
  completionHeadSha,
  eventHeadSha,
  liveHeadSha,
  eventAction
}) {
  const completionRecordedForLiveHead =
    completionHeadSha !== null && completionHeadSha === liveHeadSha;
  // A push raced the edited job: the event still carries the older head the
  // boxes were ticked against.
  const ticksPredateLiveHead =
    completionHeadSha === null &&
    checklistComplete &&
    eventHeadSha !== liveHeadSha;
  // A complete checklist with no recorded head on synchronize has no
  // provenance for which head was attested. The edited job may still be
  // queued for an older head; do not let this push inherit that attestation.
  const unrecordedCompleteOnSynchronize =
    completionHeadSha === null &&
    checklistComplete &&
    eventAction === "synchronize";

  return (
    checklistRequired &&
    readinessPresent &&
    ((completionHeadSha !== null && !completionRecordedForLiveHead) ||
      ticksPredateLiveHead ||
      unrecordedCompleteOnSynchronize)
  );
}

module.exports = {
  READINESS_LATEST_DEV_BEHIND_MAX,
  readinessClaimViolations,
  unresolvedFindingsClaim,
  STATE_PATTERN,
  READINESS_STATE_PATTERN,
  GATE_STATE_PATTERN,
  READINESS_STATE_VERSION,
  REVIEW_FINDINGS_BOT_LOGINS,
  CODE_RABBIT_ACTIONABLE_RE,
  coderabbitOutsideDiffFindings,
  parseState,
  stateMarker,
  parseReadinessState,
  readinessStateMarker,
  parseGateState,
  gateStateMarker,
  defaultGateState,
  migrateLegacyGateState,
  clearedEnforcerState,
  defaultEnforcerState,
  defaultReadinessState,
  completionIsStale
};
