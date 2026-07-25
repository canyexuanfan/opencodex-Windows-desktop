"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKER,
  ISSUE_BODY_MAX,
  hashSourceContent,
  extractTranslationState,
  stripTranslationBlock,
  appendTranslationBlock,
  appendThrottleBlock,
  shouldTranslate,
  nextTranslationState,
  buildTranslationBlock,
  fitTranslationBody,
} = require("./issue-translation.cjs");

const SOURCE = [
  "### Was funktioniert nicht?",
  "Der Proxy startet nicht nach dem Update.",
  "### Schritte",
  "1. ocx start",
  "2. Fehler in der Konsole",
].join("\n");

describe("issue-translation", () => {
  it("round-trips strip and append", () => {
    const state = nextTranslationState({
      sourceHash: hashSourceContent({ body: SOURCE }),
      recent: [],
      now: 1_700_000_000_000,
    });
    const withTranslation = appendTranslationBlock(
      SOURCE,
      "The proxy does not start after the update.",
      state,
    );
    assert.ok(withTranslation.includes(MARKER));
    assert.ok(withTranslation.includes("<summary>Translated Message</summary>"));
    assert.equal(stripTranslationBlock(withTranslation), SOURCE);
  });

  it("preserves suffix appended after the translation block", () => {
    const state = nextTranslationState({
      sourceHash: hashSourceContent({ body: SOURCE }),
      recent: [],
      now: 1_700_000_000_000,
    });
    const suffix = "Extra maintainer note after translation.";
    const withTranslation = appendTranslationBlock(SOURCE, "Translation", state) + "\n\n" + suffix;
    assert.equal(stripTranslationBlock(withTranslation), `${SOURCE}\n\n${suffix}`);
  });

  it("includes the title in source fingerprints", () => {
    const bodyHash = hashSourceContent({ body: SOURCE });
    const withTitle = hashSourceContent({ title: "Neuer Titel", body: SOURCE });
    assert.notEqual(bodyHash, withTitle);
  });

  it("extracts embedded state", () => {
    const state = { v: 1, sourceHash: "abc", translatedAt: 1, recent: [1] };
    const block = buildTranslationBlock("Hello", state);
    const body = SOURCE + block;
    assert.deepEqual(extractTranslationState(body), state);
  });

  it("records throttle-only markers without details", () => {
    const state = nextTranslationState({
      sourceHash: hashSourceContent({ title: "T", body: SOURCE }),
      recent: [],
      now: 1_700_000_000_000,
    });
    const body = appendThrottleBlock(SOURCE, state);
    assert.ok(body.includes(MARKER));
    assert.ok(!body.includes("<details>"));
    assert.equal(stripTranslationBlock(body), SOURCE);
  });

  it("skips when source content is unchanged", () => {
    const state = nextTranslationState({
      sourceHash: hashSourceContent({ body: SOURCE }),
      recent: [],
      now: 1_700_000_000_000,
    });
    const body = appendTranslationBlock(SOURCE, "Translation", state);
    const priorState = extractTranslationState(body);
    const decision = shouldTranslate({
      sourceBody: stripTranslationBlock(body),
      priorState,
      now: priorState.translatedAt + 120_000,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "unchanged_source");
  });

  it("re-translates when only the title changes", () => {
    const state = nextTranslationState({
      sourceHash: hashSourceContent({ title: "Alt", body: SOURCE }),
      recent: [],
      now: 1_700_000_000_000,
    });
    const body = appendTranslationBlock(SOURCE, "Translation", state);
    const priorState = extractTranslationState(body);
    const decision = shouldTranslate({
      sourceTitle: "Neuer Titel",
      sourceBody: stripTranslationBlock(body),
      priorState,
      now: priorState.translatedAt + 120_000,
    });
    assert.equal(decision.ok, true);
  });

  it("skips when edits arrive too quickly", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 1,
      sourceHash: "old",
      translatedAt: now,
      recent: [now],
    };
    const decision = shouldTranslate({
      sourceBody: SOURCE + "\nExtra detail.",
      priorState,
      now: now + 5_000,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "rate_limited_interval");
  });

  it("skips when hourly translation budget is exhausted", () => {
    const now = 1_700_000_000_000;
    const recent = Array.from({ length: 10 }, (_, i) => now - i * 120_000);
    const priorState = {
      v: 1,
      sourceHash: "old",
      translatedAt: now - 3_600_000,
      recent,
    };
    const decision = shouldTranslate({
      sourceBody: SOURCE + "\nAnother edit.",
      priorState,
      now,
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, "rate_limited_hourly");
  });

  it("allows translation after source changes and cooldown", () => {
    const now = 1_700_000_000_000;
    const priorState = {
      v: 1,
      sourceHash: "old",
      translatedAt: now - 120_000,
      recent: [now - 120_000],
    };
    const decision = shouldTranslate({
      sourceBody: SOURCE + "\nNeue Information.",
      priorState,
      now,
    });
    assert.equal(decision.ok, true);
    assert.ok(decision.sourceHash);
  });

  it("truncates translations that would exceed the issue body limit", () => {
    const big = "x".repeat(60_000);
    const state = nextTranslationState({
      sourceHash: hashSourceContent({ body: big }),
      recent: [],
      now: 1_700_000_000_000,
    });
    const fitted = fitTranslationBody(big, "y".repeat(80_000), state);
    assert.ok(fitted.length < 80_000);
    assert.match(fitted, /truncated to fit GitHub issue body limit/);
    const next = appendTranslationBlock(big, fitted, state);
    assert.ok(next.length <= ISSUE_BODY_MAX);
  });
});
