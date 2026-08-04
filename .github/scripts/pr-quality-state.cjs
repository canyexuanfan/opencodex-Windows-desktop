"use strict";

/** Regex that finds the enforcer state marker inside a bot comment body. */
const STATE_PATTERN =
  /<!-- (?:wrong-branch-enforcer|pr-quality-enforcer)-state:([\s\S]*?) -->/;
/** Regex that finds the readiness state marker inside a bot comment body. */
const READINESS_STATE_PATTERN =
  /<!-- pr-quality-readiness-state:([\s\S]*?) -->/;

/**
 * v2 adds `completedAtHeadSha` so a completed checklist is bound to the exact
 * head it attested. v1 states (no field) are read the same way: the binding
 * only starts on the next completion.
 */
const READINESS_STATE_VERSION = 2;

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
 * A completed checklist is an attestation about a specific head. The
 * attestation is stale when the recorded completion head differs from the
 * live head (new commits landed after the last completion) or when the boxes
 * were ticked in an event that saw an older head than the live one — a push
 * raced the `edited` job, so no completion head was recorded yet but the
 * ticks predate the code under review — or when a synchronize event sees a
 * complete checklist with no recorded head at all (the completion job may
 * still be queued for an older head).
 */
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
  STATE_PATTERN,
  READINESS_STATE_PATTERN,
  READINESS_STATE_VERSION,
  parseState,
  stateMarker,
  parseReadinessState,
  readinessStateMarker,
  clearedEnforcerState,
  defaultEnforcerState,
  defaultReadinessState,
  completionIsStale
};
