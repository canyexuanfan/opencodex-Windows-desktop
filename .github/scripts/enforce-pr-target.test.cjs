"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("enforce-pr-target workflow", () => {
  const workflowPath = path.join(__dirname, "../workflows/enforce-pr-target.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  it("uses pull_request_target without checking out PR head code", () => {
    assert.match(workflow, /pull_request_target:/);
    assert.doesNotMatch(
      workflow,
      /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
      "enforcer must not check out untrusted PR head code",
    );
  });

  it("grants contents:write so draft GraphQL mutations work with GITHUB_TOKEN", () => {
    // convertPullRequestToDraft / markPullRequestReadyForReview fail with
    // "Resource not accessible by integration" when contents stays unset/read
    // (seen on #626). Assert the real permissions block, not comment text
    // that also mentions these scopes.
    const permissionsBlock = workflow.match(/^permissions:\n((?:[ \t]+.+\n)+)/m);
    assert.ok(permissionsBlock, "workflow must declare a top-level permissions block");
    const lines = permissionsBlock[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(lines, ["contents: write", "pull-requests: write"]);
  });

  it("fails the required check on a wrong base even if draft conversion fails", () => {
    assert.match(workflow, /core\.setFailed\(/);
    assert.match(workflow, /draftConversionFailed/);
    assert.match(workflow, /Could not convert pull request to draft/);
  });

  it("soft-fails ready-for-review restoration the same way", () => {
    assert.match(workflow, /readyConversionFailed/);
    assert.match(workflow, /Could not mark pull request ready for review/);
  });

  it("listens for synchronize so rebase can clear ancestry failures", () => {
    assert.match(workflow, /synchronize/);
  });

  it("does not add review events that would break the trusted-base model", () => {
    // `pull_request_review` / `pull_request_review_comment` load the workflow
    // from the PR head branch (like `pull_request`), while this workflow's
    // checkout pins the base SHA — head YAML + base scripts mismatch, so the
    // gate crashes (`parseGateState is not a function`) and the head controls
    // the workflow definition under a write token. The findings claim runs on
    // every `pull_request_target` event instead (opened/edited/synchronize/
    // ready_for_review).
    assert.doesNotMatch(workflow, /^  pull_request_review:/m);
    assert.doesNotMatch(workflow, /^  pull_request_review_comment:/m);
  });

  it("queries review threads and feeds them to the findings claim check", () => {
    // Paginated read: `after: $cursor` + `pageInfo.hasNextPage`, so a busy PR
    // with more than 100 threads cannot hide unresolved bot threads (fail-open
    // gap in a fail-closed check).
    assert.match(workflow, /reviewThreads\(first: 100, after: \$cursor\)/);
    assert.match(workflow, /hasNextPage/);
    assert.match(workflow, /unresolvedFindingsClaim/);
    assert.match(workflow, /findingsClaim\.byBot/);
    assert.match(workflow, /review_findings/);
  });

  it("fails closed when review threads cannot be read", () => {
    assert.match(workflow, /findingsUnverifiable/);
    assert.match(workflow, /findings claim could not be verified/);
  });

  it("writes exactly one consolidated comment via a single upsert helper", () => {
    assert.match(workflow, /GATE_MARKER,/);
    assert.match(workflow, /comment\.body\?\.includes\(GATE_MARKER\)/);
    assert.match(workflow, /upsertGateComment/);
    assert.match(workflow, /buildGateCommentBody/);
    // No legacy two-comment write path remains.
    assert.doesNotMatch(workflow, /upsertReadinessComment/);
    assert.doesNotMatch(workflow, /buildReadinessCommentBody/);
    // No intermediate checkpoint comment writes.
    assert.doesNotMatch(workflow, /Draft conversion pending/);
    assert.doesNotMatch(workflow, /Recording ownership state/);
  });

  it("manages the review-ready status label at the ready moment", () => {
    assert.match(workflow, /REVIEW_READY_LABEL\s*=\s*"review-ready"/);
    assert.match(workflow, /github\.rest\.issues\.addLabels/);
    assert.match(workflow, /github\.rest\.issues\.removeLabel/);
    assert.match(workflow, /reviewReadyDesired/);
    // A positive labels filter in .coderabbit.yaml would restrict ALL reviews
    // to labeled PRs (maintainer PRs never carry this label), so the label is
    // kept as a visible status marker only and never wired as a CodeRabbit
    // auto-review filter.
    assert.doesNotMatch(workflow, /labels:\s*\["?review-ready"?\]/);
  });

  it("migrates legacy two-comment PRs and deletes the old comments", () => {
    assert.match(workflow, /migrateLegacyCommentsIfNeeded/);
    assert.match(workflow, /migrateLegacyGateState/);
    assert.match(workflow, /github\.rest\.issues\.deleteComment/);
    assert.match(workflow, /legacyEnforcerComment/);
    assert.match(workflow, /legacyReadinessComment/);
  });

  it("checks out trusted base-branch scripts only (never PR head)", () => {
    // Scope the assertions to the checkout step itself, so a stray `ref:` on
    // another step cannot satisfy the pin while the checkout stays mutable.
    const checkoutStep = workflow
      .split("- name: Checkout trusted PR-quality scripts")[1]
      .split(/\n {6}- name:/)[0];
    assert.match(checkoutStep, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(checkoutStep, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
    // The readiness ping reads MAINTAINERS.md from the same trusted checkout.
    assert.match(checkoutStep, /sparse-checkout:\s*\|\s*\n\s*\.github\/scripts\n\s*MAINTAINERS\.md/);
    assert.match(checkoutStep, /persist-credentials:\s*false/);
    assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
  });

  it("loads pr-quality via require from the checked-out scripts", () => {
    assert.match(workflow, /pr-quality\.cjs/);
    assert.match(workflow, /collectPrQualityFailures/);
  });

  it("checks stacked bases via open PR heads before wrong_base enforcement", () => {
    assert.match(workflow, /stackedBase/);
    assert.match(workflow, /github\.rest\.pulls\.list/);
    assert.match(workflow, /treating as stacked/);
    assert.match(workflow, /other\.base\?\.repo\?\.owner/);
    const qualityCall = workflow.match(
      /collectPrQualityFailures\(\{([\s\S]*?)\}\);/,
    );
    assert.ok(qualityCall, "must call collectPrQualityFailures");
    assert.match(qualityCall[1], /stackedBase/);
  });

  it("strips stale WRONG BRANCH prefix on failure when base is corrected", () => {
    const failureBlock = workflow.match(
      /if \(mustDraft\) \{([\s\S]*?)core\.setFailed\(/,
    );
    assert.ok(failureBlock, "workflow must have a draft path");
    const failurePath = failureBlock[1];
    assert.match(failurePath, /shouldStripTitlePrefix/);
    assert.match(failurePath, /!hasWrongBase/);
    assert.match(failurePath, /titlePrefixedByBot = false/);
    assert.match(failurePath, /pr\.title\.slice\(TITLE_PREFIX\.length\)/);
  });
});
