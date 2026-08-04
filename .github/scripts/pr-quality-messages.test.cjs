"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildReviewReadinessSection
} = require("./pr-quality.cjs");
const {
  READINESS_MARKER,
  inlineCode,
  readinessChecklistLines,
  buildReadinessCommentBody,
  descriptionFailureLines,
  buildFailureSections,
  failureSummary,
  buildStaleNotice
} = require("./pr-quality-messages.cjs");

const PR = {
  base: { ref: "main" },
  user: { login: "contributor" }
};
const ALLOWED_BASES = ["dev"];
const DEFAULT_BASE = "dev";

describe("inlineCode", () => {
  it("wraps values in backticks and escapes embedded backticks", () => {
    assert.equal(inlineCode("dev"), "`dev`");
    assert.equal(inlineCode("a`b"), "`a\\`b`");
    assert.equal(inlineCode(42), "`42`");
  });
});

describe("readinessChecklistLines", () => {
  it("mirrors per-item checked state", () => {
    const readiness = {
      items: [{ checked: true }, { checked: false }, { checked: true }, { checked: false }]
    };
    const lines = readinessChecklistLines(readiness);
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^\- ✅ /);
    assert.match(lines[1], /^\- ⬜ /);
  });
});

describe("buildReadinessCommentBody", () => {
  const readiness = {
    present: true,
    complete: false,
    checked: 1,
    total: 4,
    items: [{ checked: true }, { checked: false }, { checked: false }, { checked: false }]
  };

  it("carries the marker, serialized state, mirror, and tick count", () => {
    const state = { version: 2, maintainersPinged: false };
    const body = buildReadinessCommentBody(state, readiness, ["extra line"]).join("\n");
    assert.ok(body.startsWith(READINESS_MARKER));
    assert.ok(body.includes('<!-- pr-quality-readiness-state:{"version":2'));
    assert.ok(body.includes("**1/4** boxes ticked."));
    assert.ok(body.includes("extra line"));
    assert.ok(body.includes("tick all four boxes there."));
  });

  it("renders the ready-for-review variant when the checklist is absent", () => {
    const body = buildReadinessCommentBody(
      { version: 2 },
      { present: false, complete: false, checked: 0, total: 0, items: [] },
      [],
    ).join("\n");
    assert.ok(body.includes("not required for this author."));
    assert.ok(!body.includes("boxes ticked"));
  });
});

describe("descriptionFailureLines", () => {
  it("covers every reason", () => {
    assert.match(descriptionFailureLines("empty").join(" "), /body is empty/);
    assert.match(descriptionFailureLines("placeholder").join(" "), /placeholder/);
    assert.match(
      descriptionFailureLines("escaped_newlines").join(" "),
      /literal `\\n` escape sequences/,
    );
    assert.match(descriptionFailureLines("thin").join(" "), /too thin/);
    assert.match(descriptionFailureLines("unknown").join(" "), /too thin/);
  });
});

describe("buildFailureSections", () => {
  it("builds a wrong-base section naming every allowed base", () => {
    const sections = buildFailureSections(
      [{ code: "wrong_base" }],
      { pr: PR, allowedBases: ALLOWED_BASES, defaultBase: DEFAULT_BASE },
    ).join("\n");
    assert.match(sections, /Wrong target branch/);
    assert.match(sections, /targets `main`/);
    assert.match(sections, /target one of `dev`/);
    assert.match(sections, /@contributor Please retarget this PR to `dev`/);
  });

  it("builds ancestry, description, and screenshot sections", () => {
    const sections = buildFailureSections(
      [
        { code: "wrong_ancestry" },
        { code: "bad_description", reason: "empty" },
        { code: "missing_ui_screenshot" }
      ],
      { pr: PR, allowedBases: ALLOWED_BASES, defaultBase: DEFAULT_BASE },
    ).join("\n");
    assert.match(sections, /Wrong branch ancestry/);
    assert.match(sections, /Pull request description/);
    assert.match(sections, /UI screenshot required/);
    assert.match(sections, /Rebase onto the current `main`/);
  });
});

describe("failureSummary", () => {
  it("names every failure kind", () => {
    assert.equal(
      failureSummary(
        [
          { code: "wrong_base" },
          { code: "wrong_ancestry" },
          { code: "bad_description", reason: "empty" },
          { code: "missing_ui_screenshot" },
          { code: "mystery" }
        ],
        { pr: PR },
      ),
      "wrong base (main); wrong ancestry; bad description (empty); missing UI screenshot; mystery",
    );
  });
});

describe("buildStaleNotice", () => {
  it("names the recorded and current heads when a completion drifted", () => {
    const notice = buildStaleNotice({
      completionHeadSha: "1111111111111111111111111111111111111111",
      liveHeadSha: "2222222222222222222222222222222222222222"
    });
    assert.match(notice[0], /completed on `1111111`; the current head is `2222222`/);
    assert.match(notice[1], /has been reset: re-test against the latest code/);
  });

  it("covers the never-recorded predate case", () => {
    const notice = buildStaleNotice({
      completionHeadSha: null,
      liveHeadSha: "2222222222222222222222222222222222222222"
    });
    assert.match(notice[0], /ticked before the current head `2222222` was pushed/);
  });

  it("matches the injected section text it resets", () => {
    // The notice must describe the exact state the reset produces: a fresh
    // unticked section from pr-quality.cjs.
    const section = buildReviewReadinessSection();
    assert.match(section, /\[ \] All CI tests are green on my local testing\./);
  });
});
