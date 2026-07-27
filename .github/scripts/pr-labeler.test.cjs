"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectTypeLabelFromTitle,
  hasHumanTypeLabelOverride,
  planTypeLabelSync,
  TYPE_LABELS,
} = require("./pr-labeler.cjs");

describe("detectTypeLabelFromTitle", () => {
  it("maps conventional prefixes to type labels", () => {
    assert.equal(detectTypeLabelFromTitle("fix(codex): warn after sync"), "bug");
    assert.equal(detectTypeLabelFromTitle("feat(images): add bridge"), "enhancement");
    assert.equal(detectTypeLabelFromTitle("docs: update guide"), "documentation");
    assert.equal(detectTypeLabelFromTitle("chore!: drop legacy"), "chore");
  });

  it("returns null without a conventional prefix", () => {
    assert.equal(detectTypeLabelFromTitle("Warn or restart stale app-server"), null);
    assert.equal(detectTypeLabelFromTitle(""), null);
    assert.equal(detectTypeLabelFromTitle("constructor: drop legacy"), null);
  });
});

describe("hasHumanTypeLabelOverride", () => {
  it("is false when only the Actions bot touched type labels", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), false);
  });

  it("is true after a human replaces the bot type label (PR #518)", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      { event: "unlabeled", label: { name: "bug" }, actor: { login: "Wibias" } },
      { event: "labeled", label: { name: "enhancement" }, actor: { login: "Wibias" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), true);
  });

  it("stays true even if the bot later reverts the human choice", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      { event: "unlabeled", label: { name: "bug" }, actor: { login: "Wibias" } },
      { event: "labeled", label: { name: "enhancement" }, actor: { login: "Wibias" } },
      { event: "unlabeled", label: { name: "enhancement" }, actor: { login: "github-actions[bot]" } },
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), true);
  });

  it("ignores non-type labels from humans", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      { event: "labeled", label: { name: "needs-triage" }, actor: { login: "Wibias" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), false);
  });
});

describe("planTypeLabelSync", () => {
  it("adds the detected label and removes other type labels when bot-owned", () => {
    const plan = planTypeLabelSync({
      title: "fix(codex): warn after sync",
      currentLabels: ["enhancement", "needs-triage"],
      events: [
        { event: "labeled", label: { name: "enhancement" }, actor: { login: "github-actions[bot]" } },
      ],
    });
    assert.deepEqual(plan, {
      skip: false,
      detected: "bug",
      add: "bug",
      remove: ["enhancement"],
    });
    assert.ok(TYPE_LABELS.has("bug"));
  });

  it("is a no-op add when the detected label is already present", () => {
    const plan = planTypeLabelSync({
      title: "fix(codex): warn after sync",
      currentLabels: ["bug"],
      events: [
        { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      ],
    });
    assert.deepEqual(plan, {
      skip: false,
      detected: "bug",
      add: null,
      remove: [],
    });
  });

  it("skips when a human has overridden the type label", () => {
    const plan = planTypeLabelSync({
      title: "fix(codex): warn after sync",
      currentLabels: ["enhancement"],
      events: [
        { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
        { event: "unlabeled", label: { name: "bug" }, actor: { login: "Wibias" } },
        { event: "labeled", label: { name: "enhancement" }, actor: { login: "Wibias" } },
      ],
    });
    assert.deepEqual(plan, { skip: true, reason: "human-override" });
  });

  it("skips titles without a conventional prefix", () => {
    const plan = planTypeLabelSync({
      title: "Warn or restart stale app-server",
      currentLabels: [],
      events: [],
    });
    assert.deepEqual(plan, { skip: true, reason: "no-prefix" });
  });
});
