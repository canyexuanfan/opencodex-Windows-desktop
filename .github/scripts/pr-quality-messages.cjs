"use strict";

const {
  REVIEW_READINESS_ITEMS
} = require("./pr-quality.cjs");
const {
  readinessStateMarker,
  READINESS_LATEST_DEV_BEHIND_MAX
} = require("./pr-quality-state.cjs");

/** Marks the bot's review-readiness checklist message. */
const READINESS_MARKER = "<!-- pr-quality-readiness -->";

function inlineCode(value) {
  const text = String(value);
  const longestBacktickRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map(run => run.length)
  );
  const delimiter = "`".repeat(longestBacktickRun + 1);
  return `${delimiter}${text}${delimiter}`;
}

function readinessChecklistLines(readiness) {
  return REVIEW_READINESS_ITEMS.map(
    (item, index) =>
      `- ${readiness.items?.[index]?.checked ? "✅" : "⬜"} ${item}`
  );
}

/**
 * The full readiness-message body: marker, serialized state, mirror lines for
 * the tickable boxes, the tick count, and the path-specific extra lines.
 */
function buildReadinessCommentBody(state, readiness, extra) {
  const complete = readiness.present && readiness.complete;

  return [
    READINESS_MARKER,
    readinessStateMarker(state),
    "",
    "## Review readiness checklist",
    "",
    readiness.present
      ? "This PR is kept in **draft** until every requirement below is fulfilled. The tickable checklist has been added to your PR description — tick all four boxes there."
      : "The review readiness checklist is not required for this author.",
    "",
    ...(readiness.present ? readinessChecklistLines(readiness) : []),
    "",
    readiness.present
      ? complete
        ? "✅ **4/4** boxes ticked."
        : `**${readiness.checked}/${readiness.total}** boxes ticked.`
      : "",
    "",
    ...extra
  ];
}

function descriptionFailureLines(reason) {
  switch (reason) {
    case "empty":
      return [
        "The pull request body is empty after stripping HTML comments.",
        "",
        "Include a real description: a **Summary** of what changed and why, plus a **Test plan** (or equivalent substance)."
      ];
    case "placeholder":
      return [
        "The pull request body contains only placeholder text (for example `N/A`, `TODO`, or `No response`).",
        "",
        "Replace placeholders with a **Summary** and **Test plan**, or another description with at least two substantive sections or paragraphs."
      ];
    case "escaped_newlines":
      return [
        "The pull request body uses literal `\\n` escape sequences instead of real line breaks.",
        "",
        "Fix the formatting so the body uses normal markdown line breaks, then add a **Summary** and **Test plan**."
      ];
    case "thin":
    default:
      return [
        "The pull request description is too thin to review.",
        "",
        "Add a **Summary** and **Test plan** (two sections with at least 40 characters each), or an unstructured body of at least 120 characters with two paragraphs or bullet groups."
      ];
  }
}

function buildFailureSections(failures, { pr, allowedBases, defaultBase }) {
  const sections = [];

  if (failures.some(failure => failure.code === "wrong_base")) {
    sections.push(
      "⚠️ **Wrong target branch**",
      "",
      `This pull request currently targets ${inlineCode(pr.base.ref)}, but pull requests must target one of ${allowedBases.map(inlineCode).join(" or ")}.`,
      "",
      `@${pr.user.login} Please retarget this PR to ${inlineCode(defaultBase)}. All contributions go to ${inlineCode(defaultBase)}; \`main\` receives only release promotions. See our [Contributing guide](https://lidge-jun.github.io/opencodex/contributing/) for details. Thanks! 🙏`
    );
  }

  if (failures.some(failure => failure.code === "wrong_ancestry")) {
    sections.push(
      "⚠️ **Wrong branch ancestry**",
      "",
      `This pull request targets ${inlineCode(pr.base.ref)}, but its head appears to sit on the current ${inlineCode("main")} tip while being far behind ${inlineCode(pr.base.ref)}.`,
      "",
      `@${pr.user.login} Rebase onto the current ${inlineCode(pr.base.ref)} branch instead of opening from ${inlineCode("main")}. That keeps already-released commits out of the integration branch.`
    );
  }

  const badDescription = failures.find(
    failure => failure.code === "bad_description"
  );
  if (badDescription) {
    sections.push(
      "⚠️ **Pull request description**",
      "",
      ...descriptionFailureLines(badDescription.reason)
    );
  }

  if (
    failures.some(
      failure => failure.code === "missing_ui_screenshot"
    )
  ) {
    sections.push(
      "⚠️ **UI screenshot required**",
      "",
      `This pull request mentions ${inlineCode("gui")} in its title or description, so it is treated as a GUI change.`,
      "",
      `@${pr.user.login} Please add a screenshot of the UI change to the description — drag and drop the image into the description editor, or paste a markdown image such as ${inlineCode("![Screenshot](https://example.com/after.png)")}. The check re-runs automatically once the description is edited.`
    );
  }

  return sections;
}

function failureSummary(failures, { pr }) {
  return failures
    .map(failure => {
      if (failure.code === "wrong_base") {
        return `wrong base (${pr.base.ref})`;
      }
      if (failure.code === "wrong_ancestry") {
        return "wrong ancestry";
      }
      if (failure.code === "bad_description") {
        return `bad description (${failure.reason})`;
      }
      if (failure.code === "missing_ui_screenshot") {
        return "missing UI screenshot";
      }
      return failure.code;
    })
    .join("; ");
}

/** The notice shown when the gate's own claim check disproves a ticked box. */
function buildClaimCheckNotice(violations, liveHeadSha) {
  const lines = [];
  for (const code of violations) {
    if (code === "ci_green") {
      lines.push(
        `GitHub CI is not green on the current head ${inlineCode(liveHeadSha.slice(0, 7))}; the **CI green** box has been unticked.`
      );
    } else if (code === "latest_dev") {
      lines.push(
        `The PR is more than ${READINESS_LATEST_DEV_BEHIND_MAX} commits behind ${inlineCode("dev")}; the **latest dev** box has been unticked.`
      );
    }
  }
  lines.push(
    "The checklist has been reset: re-test against the latest code and tick the boxes again."
  );
  return lines;
}

/** The reset notice shown when a completion no longer covers the live head. */
function buildStaleNotice({ completionHeadSha, liveHeadSha, eventAction }) {
  let lead;
  if (completionHeadSha !== null) {
    lead = `New commits were pushed after the checklist was completed on ${inlineCode(String(completionHeadSha).slice(0, 7))}; the current head is ${inlineCode(liveHeadSha.slice(0, 7))}.`;
  } else if (eventAction === "synchronize") {
    lead = `A complete checklist was found on a synchronize event with no recorded completion head; the current head is ${inlineCode(liveHeadSha.slice(0, 7))}.`;
  } else {
    lead = `The checklist was ticked before the current head ${inlineCode(liveHeadSha.slice(0, 7))} was pushed.`;
  }
  return [
    lead,
    "The checklist has been reset: re-test against the latest code and tick all four boxes again."
  ];
}

module.exports = {
  READINESS_MARKER,
  inlineCode,
  readinessChecklistLines,
  buildReadinessCommentBody,
  descriptionFailureLines,
  buildFailureSections,
  failureSummary,
  buildStaleNotice,
  buildClaimCheckNotice
};
