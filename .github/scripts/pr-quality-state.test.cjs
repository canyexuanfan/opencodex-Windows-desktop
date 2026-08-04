"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseState,
  stateMarker,
  parseReadinessState,
  readinessStateMarker,
  clearedEnforcerState,
  defaultEnforcerState,
  defaultReadinessState,
  completionIsStale,
  READINESS_STATE_VERSION
} = require("./pr-quality-state.cjs");

describe("enforcer state markers", () => {
  it("parses a valid enforcer state marker", () => {
    const state = { version: 1, active: true, autoDraftedByBot: true };
    assert.deepEqual(
      parseState(`<!-- pr-quality-enforcer-state:${JSON.stringify(state)} -->`),
      state,
    );
    assert.deepEqual(
      parseState(
        `<!-- wrong-branch-enforcer-state:${JSON.stringify(state)} -->`,
      ),
      state,
    );
  });

  it("returns null for markerless or unreadable state and warns", () => {
    assert.equal(parseState("plain comment"), null);
    assert.equal(parseState(null), null);
    const warnings = [];
    assert.equal(
      parseState("<!-- pr-quality-enforcer-state:{not json} -->", message =>
        warnings.push(message),
      ),
      null,
    );
    assert.match(warnings[0], /Could not parse stored workflow state/);
  });

  it("round-trips through stateMarker", () => {
    const state = { version: 1, active: false };
    assert.deepEqual(parseState(stateMarker(state)), state);
  });

  it("parses and serializes readiness state with warnings on failure", () => {
    const state = { version: 2, maintainersPinged: true };
    assert.deepEqual(
      parseReadinessState(
        `<!-- pr-quality-readiness-state:${JSON.stringify(state)} -->`,
      ),
      state,
    );
    assert.deepEqual(parseReadinessState(readinessStateMarker(state)), state);
    const warnings = [];
    assert.equal(
      parseReadinessState("<!-- pr-quality-readiness-state:{bad -->", m =>
        warnings.push(m),
      ),
      null,
    );
    assert.match(warnings[0], /Could not parse stored readiness state/);
  });
});

describe("state defaults", () => {
  it("builds the cleared enforcer state", () => {
    assert.deepEqual(clearedEnforcerState(), {
      version: 1,
      active: false,
      autoDraftedByBot: false,
      titlePrefixedByBot: false,
      ancestryFailed: false,
      descriptionFailed: false,
      screenshotFailed: false
    });
  });

  it("builds the fresh active enforcer state", () => {
    const state = defaultEnforcerState();
    assert.equal(state.active, true);
    assert.equal(state.version, 1);
  });

  it("builds the fresh readiness state at the current version", () => {
    assert.deepEqual(defaultReadinessState(), {
      version: READINESS_STATE_VERSION,
      autoDraftedByBot: false,
      maintainersPinged: false,
      completedAtHeadSha: null
    });
  });
});

describe("completionIsStale", () => {
  const base = {
    checklistRequired: true,
    readinessPresent: true,
    liveHeadSha: "2222222222222222222222222222222222222222"
  };

  it("is not stale when the recorded completion head matches the live head", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: base.liveHeadSha,
        eventHeadSha: base.liveHeadSha
      }),
      false,
    );
  });

  it("is stale when the recorded head differs from the live head, even with an open checklist", () => {
    // Open checklist + mismatched recorded head is the partial-reset window.
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: false,
        completionHeadSha: "1111111111111111111111111111111111111111",
        eventHeadSha: base.liveHeadSha
      }),
      true,
    );
  });

  it("is stale when ticks predate the live head on a first completion", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: "1111111111111111111111111111111111111111"
      }),
      true,
    );
  });

  it("is not stale when ticks predate the live head but nothing is ticked", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: false,
        completionHeadSha: null,
        eventHeadSha: "1111111111111111111111111111111111111111"
      }),
      false,
    );
  });
  it("is stale when a complete checklist has no recorded head on synchronize", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: base.liveHeadSha,
        eventAction: "synchronize"
      }),
      true,
    );
  });

  it("is not stale for an unrecorded complete checklist on a non-synchronize event", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistComplete: true,
        completionHeadSha: null,
        eventHeadSha: base.liveHeadSha,
        eventAction: "edited"
      }),
      false,
    );
  });


  it("is not stale for maintainers or absent checklists", () => {
    assert.equal(
      completionIsStale({
        ...base,
        checklistRequired: false,
        checklistComplete: true,
        completionHeadSha: "1111111111111111111111111111111111111111",
        eventHeadSha: base.liveHeadSha
      }),
      false,
    );
    assert.equal(
      completionIsStale({
        ...base,
        readinessPresent: false,
        checklistComplete: true,
        completionHeadSha: "1111111111111111111111111111111111111111",
        eventHeadSha: base.liveHeadSha
      }),
      false,
    );
  });
});
