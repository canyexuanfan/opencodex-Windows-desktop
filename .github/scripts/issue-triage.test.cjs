"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  hardenRelatedMatches,
  parseTriageMatches,
  parseAiJson,
  sanitizeReason,
} = require("./issue-triage.cjs");

describe("hardenRelatedMatches", () => {
  it("drops #452-style weak related links to unrelated HTTP errors", () => {
    const result = hardenRelatedMatches({
      duplicates: [],
      related: ["420"],
      reason:
        "The new issue involves a 503 error from the Codex proxy which is somewhat related to the 400 error reported in issue 420, as both issues pertain to errors in content serialization with the Codex app.",
    });
    assert.deepEqual(result.related, []);
    assert.deepEqual(result.duplicates, []);
  });

  it("drops generic same-client / same-app overlap without a concrete signature", () => {
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: ["1"],
        reason: "Same client and both are general proxy errors.",
      }).related,
      [],
    );
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: ["2"],
        reason: "Both use Codex and return an HTTP error.",
      }).related,
      [],
    );
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: ["3"],
        reason: "Same app, vaguely related failures.",
      }).related,
      [],
    );
  });

  it("keeps related when same-client wording also has a concrete signature", () => {
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: ["410"],
        reason:
          "Same client, exact ECONNRESET on /v1/responses in the OpenRouter adapter.",
      }).related,
      ["410"],
    );
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: ["411"],
        reason:
          "Same app, exact 503 from POST /v1/responses with the Xiaomi openai-chat adapter.",
      }).related,
      ["411"],
    );
    assert.deepEqual(
      hardenRelatedMatches({
        duplicates: [],
        related: ["412"],
        reason:
          "Both reproduce when content[0].text is an object instead of a string.",
      }).related,
      ["412"],
    );
  });

  it("keeps related when the reason states a concrete shared failure", () => {
    const result = hardenRelatedMatches({
      duplicates: [],
      related: ["410", "411"],
      reason:
        "Same Xiaomi openai-chat adapter returns 503 on /v1/responses after Codex sync while curl succeeds.",
    });
    assert.deepEqual(result.related, ["410", "411"]);
  });

  it("keeps related when 'both involve' names a concrete shared failure", () => {
    const result = hardenRelatedMatches({
      duplicates: [],
      related: ["410"],
      reason:
        "Both issues involve the exact ECONNRESET error on /v1/responses in the OpenRouter adapter.",
    });
    assert.deepEqual(result.related, ["410"]);
  });

  it("caps related at 3 and never overlaps duplicates", () => {
    const result = hardenRelatedMatches({
      duplicates: ["100"],
      related: ["100", "101", "102", "103", "104"],
      reason: "Same listen-port reclaim failure after Windows taskkill leaves ghost LISTEN on 10100.",
    });
    assert.deepEqual(result.duplicates, ["100"]);
    assert.deepEqual(result.related, ["101", "102", "103"]);
  });

  it("drops related when the reason is missing or tiny", () => {
    assert.deepEqual(
      hardenRelatedMatches({ duplicates: [], related: ["9"], reason: "same" }).related,
      [],
    );
  });
});

describe("parseTriageMatches", () => {
  it("returns null when hardening clears a weak related-only match", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: [],
        related: ["420"],
        reason:
          "somewhat related Codex App HTTP errors; both pertain to errors in the proxy",
      }),
      { currentNumber: 452, knownNumbers: ["420", "451"] },
    );
    assert.equal(matches, null);
  });

  it("keeps strong duplicates even if related is weak", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: ["420"],
        related: ["451"],
        reason: "somewhat related to other Codex errors in general",
      }),
      { currentNumber: 452, knownNumbers: new Set(["420", "451"]) },
    );
    assert.deepEqual(matches.duplicates, ["420"]);
    assert.deepEqual(matches.related, []);
  });

  it("ignores unknown and self issue numbers", () => {
    const matches = parseTriageMatches(
      JSON.stringify({
        duplicates: ["#420", "452", "999"],
        related: [],
        reason: "Exact same Anthropic messages.0.content.N.text.text Field required failure.",
      }),
      { currentNumber: 452, knownNumbers: ["420"] },
    );
    assert.deepEqual(matches.duplicates, ["420"]);
  });
});

describe("parseAiJson", () => {
  it("strips a json fence before parsing", () => {
    assert.deepEqual(
      parseAiJson("```json\n{\"duplicates\":[]}\n```"),
      { duplicates: [] },
    );
  });

  it("returns null for unparseable input", () => {
    assert.equal(parseAiJson("not json at all"), null);
  });
});

describe("sanitizeReason", () => {
  it("strips markdown and mention markers", () => {
    assert.equal(
      sanitizeReason("see @user and #420 with `code`"),
      "see (at)user and 420 with code",
    );
  });
});
