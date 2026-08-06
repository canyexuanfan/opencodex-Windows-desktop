"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildReviewReadinessSection
} = require("./pr-quality.cjs");
const {
  GATE_MARKER,
  inlineCode,
  readinessChecklistLines,
  buildGateCommentBody,
  descriptionFailureLines,
  buildFailureSections,
  failureSummary,
  buildStaleNotice,
  buildClaimCheckNotice,
  buildFindingsClaimNotice
} = require("./pr-quality-messages.cjs");

const PR = {
  base: { ref: "main" },
  user: { login: "contributor" }
};
const ALLOWED_BASES = ["dev"];
const DEFAULT_BASE = "dev";

describe("inlineCode", () => {
  it("wraps values with a delimiter longer than any backtick run", () => {
    assert.equal(inlineCode("dev"), "`dev`");
    assert.equal(inlineCode("a`b"), "``a`b``");
    assert.equal(inlineCode("a``b"), "```a``b```");
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

describe("buildGateCommentBody", () => {
  const readiness = {
    present: true,
    complete: false,
    checked: 1,
    total: 4,
    items: [{ checked: true }, { checked: false }, { checked: false }, { checked: false }]
  };

  it("carries the marker, serialized state, status, mirror, and tick count", () => {
    const state = { version: 1, maintainersPinged: false };
    const body = buildGateCommentBody(state, {
      status: "DRAFT",
      statusReason: "review readiness checklist open (1/4 boxes ticked).",
      actions: ["Tick all four boxes in the PR description once you're done."],
      readiness,
      checklistRequired: true,
      notices: ["extra line"]
    }).join("\n");
    assert.ok(body.startsWith(GATE_MARKER));
    assert.ok(body.includes('<!-- opencodex-pr-gate-state:{"version":1'));
    assert.ok(body.includes("## ⏳ DRAFT"));
    assert.ok(body.includes("## What to do"));
    assert.ok(body.includes("Tick all four boxes"));
    assert.ok(body.includes("## Review readiness checklist"));
    assert.ok(body.includes("**1/4** boxes ticked."));
    assert.ok(body.includes("extra line"));
  });

  it("renders a ready status without a checklist when not required", () => {
    const body = buildGateCommentBody(
      { version: 1 },
      {
        status: "READY",
        statusReason: "this PR is ready for review.",
        actions: [],
        readiness: { present: false, complete: false, checked: 0, total: 0, items: [] },
        checklistRequired: false,
        notices: ["⚠️ **Wrong target branch**"]
      },
    ).join("\n");
    assert.ok(body.includes("## ✅ READY"));
    assert.ok(!body.includes("## Review readiness checklist"));
    assert.ok(!body.includes("boxes ticked"));
    assert.ok(body.includes("⚠️ **Wrong target branch**"));
  });

  it("does not claim ready when the PR is kept in draft", () => {
    const body = buildGateCommentBody(
      { version: 1 },
      {
        status: "DRAFT",
        statusReason: "PR is kept in draft.",
        actions: [],
        readiness,
        checklistRequired: true,
        notices: []
      },
    ).join("\n");
    assert.ok(!body.includes("READY"));
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
    assert.ok(notice[0].includes("ticked before the current head `2222222` was pushed"));
  });

  it("covers an unrecorded complete checklist on synchronize", () => {
    const notice = buildStaleNotice({
      completionHeadSha: null,
      liveHeadSha: "2222222222222222222222222222222222222222",
      eventAction: "synchronize"
    });
    assert.match(
      notice[0],
      /synchronize event with no recorded completion head/,
    );
    assert.ok(notice[0].includes("current head is `2222222`"));
  });

  it("matches the injected section text it resets", () => {
    // The notice must describe the exact state the reset produces: a fresh
    // unticked section from pr-quality.cjs.
    const section = buildReviewReadinessSection();
    assert.match(section, /\[ \] All CI tests are green on my local testing\./);
  });
});

describe("buildClaimCheckNotice", () => {
  it("names each violated claim and the reset action", () => {
    const notice = buildClaimCheckNotice(
      ["ci_green", "latest_dev"],
      "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
    );
    assert.match(notice[0], /CI is not green on the current head `3f1c0de`/);
    assert.match(notice[0], /\*\*CI green\*\* box has been unticked/);
    assert.match(notice[1], /more than 10 commits behind `dev`/);
    assert.match(notice[1], /\*\*latest dev\*\* box has been unticked/);
    assert.match(notice[2], /reset: re-test against the latest code/);
  });

  it("handles a single violation", () => {
    const notice = buildClaimCheckNotice(["ci_green"], "a".repeat(40));
    assert.equal(notice.length, 2);
    assert.match(notice[0], /CI is not green/);
    assert.match(notice[1], /has been reset/);
  });

  it("returns only the reset line for an empty violation list", () => {
    const notice = buildClaimCheckNotice([], "a".repeat(40));
    assert.deepEqual(notice, [
      "The checklist has been reset: re-test against the latest code and tick the boxes again.",
    ]);
  });
});

describe("buildFindingsClaimNotice", () => {
  it("names each bot with unresolved threads and the untick", () => {
    const notice = buildFindingsClaimNotice({
      "chatgpt-codex-connector[bot]": 2,
      "coderabbitai[bot]": 1,
    });
    assert.match(notice[0], /Codex has 2 unresolved findings/);
    assert.match(notice[0], /\*\*Codex\/CodeRabbit findings\*\* box has been unticked/);
    assert.match(notice[1], /CodeRabbit has 1 unresolved finding/);
    assert.match(notice[2], /Resolve every open review conversation/);
  });

  it("handles a single bot with one thread", () => {
    const notice = buildFindingsClaimNotice({ "coderabbitai[bot]": 1 });
    assert.equal(notice.length, 2);
    assert.match(notice[0], /CodeRabbit has 1 unresolved finding/);
    assert.match(notice[1], /Resolve every open review conversation/);
  });
});
