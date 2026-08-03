"use strict";

const path = require("node:path");
const {
  clean,
  isPlaceholderOnlyValue,
  hasSubstantialStructuredContent,
} = require(path.join(__dirname, "issue-quality.cjs"));

const ANCESTRY_BEHIND_THRESHOLD = 20;
/** Cap on ahead_by vs main so stale `dev` forks (many commits ahead of main) are not flagged. */
const ANCESTRY_AHEAD_MAIN_MAX = 5;
const MIN_SECTION_LEN = 40;
const MIN_RICH_SECTIONS = 2;
const UNSTRUCTURED_MIN_LEN = 120;
const UNSTRUCTURED_MIN_BLOCKS = 2;

/**
 * Exact instruction / checklist lines from `.github/PULL_REQUEST_TEMPLATE.md`.
 * Untouched templates must not count as substance.
 */
const PR_TEMPLATE_BOILERPLATE_LINES = new Set([
  "explain the user-visible or maintainer-facing change.",
  "list the commands or checks you ran.",
  "if this pr changes the gui, include a screenshot of the ui change in the description.",
  "scope stays focused and avoids unrelated cleanup.",
  "docs or release notes were updated when needed.",
  "security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
]);

/** Case-insensitive whole-word match for the GUI surface (repo convention: `gui/`). */
const GUI_CUE_RE = /\bgui\b/i;
/** Embedded markdown image (`![alt](url)`), as GitHub renders for dropped images. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;
/** Embedded HTML image (`<img ...>`). */
const HTML_IMAGE_RE = /<img\b[^>]*>/i;

function isWrongAncestry({
  behindMain,
  behindBase,
  aheadMain = 0,
  threshold = ANCESTRY_BEHIND_THRESHOLD,
  aheadMainMax = ANCESTRY_AHEAD_MAIN_MAX,
}) {
  return (
    behindMain === 0 &&
    behindBase >= threshold &&
    aheadMain <= aheadMainMax
  );
}

function authorHasPushPermission(permission) {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/**
 * True when the body uses literal backslash-n as the dominant line break
 * (agent bug seen on #644) rather than real newlines.
 */
function hasEscapedNewlines(text) {
  const escaped = (text.match(/\\n/g) || []).length;
  if (escaped < 2) return false;
  const real = (text.match(/\n/g) || []).length;
  return escaped > real;
}

function countContentBlocks(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length >= 2) return blocks.length;
  const bullets = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+\S/.test(l));
  return Math.max(blocks.length, bullets.length);
}

function normalizeTemplateLine(line) {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\[[ xX]\]\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .trim()
    .toLowerCase();
}

/** Drop stock PR template headings, instructions, and checklist lines. */
function stripPrTemplateBoilerplate(text) {
  return text
    .split("\n")
    .filter((line) => {
      const normalized = normalizeTemplateLine(line);
      if (!normalized) return true;
      if (PR_TEMPLATE_BOILERPLATE_LINES.has(normalized)) return false;
      if (/^(summary|verification|checklist)$/.test(normalized)) return false;
      return true;
    })
    .join("\n");
}

function assessPrDescription(body) {
  if (typeof body !== "string" || !body.trim()) {
    return { ok: false, reason: "empty" };
  }
  if (hasEscapedNewlines(body)) {
    return { ok: false, reason: "escaped_newlines" };
  }
  const withoutTemplate = stripPrTemplateBoilerplate(body);
  const cleaned = clean(withoutTemplate);
  if (!cleaned) {
    const strippedComments = withoutTemplate.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!strippedComments) return { ok: false, reason: "empty" };
    if (isPlaceholderOnlyValue(strippedComments)) {
      return { ok: false, reason: "placeholder" };
    }
    return { ok: false, reason: "empty" };
  }
  if (isPlaceholderOnlyValue(cleaned)) {
    return { ok: false, reason: "placeholder" };
  }
  if (hasSubstantialStructuredContent(cleaned, MIN_SECTION_LEN, MIN_RICH_SECTIONS)) {
    return { ok: true };
  }
  if (
    cleaned.length >= UNSTRUCTURED_MIN_LEN &&
    countContentBlocks(cleaned) >= UNSTRUCTURED_MIN_BLOCKS
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "thin" };
}

/**
 * True when the PR title or description names the GUI surface as a whole word.
 * The description is template-stripped first so the template's own screenshot
 * instruction cannot arm the gate on its own.
 */
function hasGuiCue(title, body) {
  return (
    (typeof title === "string" && GUI_CUE_RE.test(title)) ||
    (typeof body === "string" && GUI_CUE_RE.test(body))
  );
}

/**
 * True when the description embeds a screenshot image (markdown image or an
 * `<img>` tag). A plain link to an image is not visual evidence in the PR.
 */
function hasScreenshotEvidence(body) {
  if (typeof body !== "string") return false;
  return MARKDOWN_IMAGE_RE.test(body) || HTML_IMAGE_RE.test(body);
}

function collectPrQualityFailures({
  baseRef,
  allowedBases,
  title = "",
  body,
  behindMain,
  behindBase,
  aheadMain = 0,
  authorPermission,
  permissionLookupFailed = false,
  ancestryLookupFailed = false,
  /** True when baseRef is another open PR's head (stacked child). */
  stackedBase = false,
}) {
  const failures = [];
  const wrongBase = !allowedBases.includes(baseRef) && !stackedBase;
  if (wrongBase) {
    failures.push({ code: "wrong_base" });
  } else {
    // Permission lookup fails closed (still evaluate ancestry). Compare API
    // failures skip ancestry — zeros would falsely pass the #644 heuristic.
    // Stacked children skip ancestry against the integration base; their parent
    // PR is the temporary target.
    const skipAncestry =
      stackedBase ||
      ancestryLookupFailed ||
      (!permissionLookupFailed && authorHasPushPermission(authorPermission));
    if (
      !skipAncestry &&
      isWrongAncestry({ behindMain, behindBase, aheadMain })
    ) {
      failures.push({ code: "wrong_ancestry" });
    }
  }

  const desc = assessPrDescription(body);
  if (!desc.ok) {
    failures.push({ code: "bad_description", reason: desc.reason });
  }

  // GUI-cued PRs must prove the UI change visually. The template's own
  // screenshot instruction is boilerplate, so it cannot trigger this gate.
  if (
    hasGuiCue(
      title,
      typeof body === "string" ? stripPrTemplateBoilerplate(body) : "",
    ) &&
    !hasScreenshotEvidence(body)
  ) {
    failures.push({ code: "missing_ui_screenshot" });
  }
  return failures;
}

module.exports = {
  ANCESTRY_BEHIND_THRESHOLD,
  ANCESTRY_AHEAD_MAIN_MAX,
  isWrongAncestry,
  authorHasPushPermission,
  assessPrDescription,
  hasGuiCue,
  hasScreenshotEvidence,
  collectPrQualityFailures,
  hasEscapedNewlines,
  stripPrTemplateBoilerplate,
};
