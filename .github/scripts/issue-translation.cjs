"use strict";

const crypto = require("crypto");

const MARKER = "<!-- opencodex-issue-inline-translator -->";
const STATE_RE = /<!-- opencodex-issue-inline-translator-state:([\s\S]*?) -->\s*/;
const ISSUE_BODY_MAX = 65536;

const DEFAULT_RATE_LIMIT = {
  minIntervalMs: 60_000,
  maxPerHour: 10,
  minSourceChars: 20,
};

/**
 * Locate the generated inline translation block (marker, state, optional details).
 * @returns {{ start: number, end: number } | null}
 */
function findTranslationBlockRange(text) {
  const markerIdx = String(text || "").indexOf(MARKER);
  if (markerIdx === -1) return null;

  let end = markerIdx + MARKER.length;
  const afterMarker = String(text).slice(end);
  const stateMatch = afterMarker.match(STATE_RE);
  if (stateMatch) {
    end += stateMatch.index + stateMatch[0].length;
  }

  const rest = String(text).slice(end);
  if (/^\s*<details>/i.test(rest)) {
    const closeRel = rest.search(/<\/details>/i);
    if (closeRel !== -1) {
      end += closeRel + "</details>".length;
    }
  }

  return { start: markerIdx, end };
}

/**
 * Fingerprint issue source text (title + body without the inline translation block).
 */
function hashSourceContent({ title = "", body = "" } = {}) {
  const payload = `${String(title).trim()}\n---\n${String(body).trim()}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/** @deprecated Use hashSourceContent */
function hashSourceBody(body) {
  return hashSourceContent({ body });
}

/**
 * Parse embedded translation state from an issue body, if present.
 */
function extractTranslationState(body) {
  const match = String(body || "").match(STATE_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Remove the inline translation block while preserving any suffix after it.
 */
function stripTranslationBlock(body) {
  const text = String(body || "");
  const range = findTranslationBlockRange(text);
  if (!range) return text.replace(/\s+$/, "");

  const before = text.slice(0, range.start).replace(/\s+$/, "");
  const after = text.slice(range.end).replace(/^\s+/, "");
  if (!after) return before;
  if (!before) return after;
  return `${before}\n\n${after}`.replace(/\s+$/, "");
}

function sanitizeTranslationBody(raw, maxChars = 60000) {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@/g, "(at)")
    .replace(/\bjavascript:/gi, "")
    .trim()
    .slice(0, maxChars);
}

function scrubDetectedLanguage(value) {
  return (
    String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 64) || "non-English"
  );
}

function buildTranslationBlock(translatedBody, state) {
  const safeBody = sanitizeTranslationBody(translatedBody);
  const stateJson = JSON.stringify(state);
  return [
    "",
    MARKER,
    `<!-- opencodex-issue-inline-translator-state:${stateJson} -->`,
    "",
    "<details>",
    "",
    "<summary>Translated Message</summary>",
    "",
    safeBody,
    "",
    "</details>",
    "",
  ].join("\n");
}

/**
 * Throttle-only marker (no visible translation) for English detection runs.
 */
function buildThrottleBlock(state) {
  const stateJson = JSON.stringify(state);
  return [
    "",
    MARKER,
    `<!-- opencodex-issue-inline-translator-state:${stateJson} -->`,
    "",
  ].join("\n");
}

function maxTranslationChars(sourceBody, state) {
  const base = stripTranslationBlock(sourceBody);
  const emptyBlock = buildTranslationBlock("", state);
  return Math.max(0, ISSUE_BODY_MAX - base.length - emptyBlock.length - 64);
}

function fitTranslationBody(sourceBody, translatedBody, state) {
  let safe = sanitizeTranslationBody(translatedBody);
  const maxChars = maxTranslationChars(sourceBody, state);
  if (safe.length <= maxChars) return safe;
  const note = "\n\n_(Translation truncated to fit GitHub issue body limit.)_";
  const budget = Math.max(0, maxChars - note.length);
  return safe.slice(0, budget).trimEnd() + note;
}

function appendTranslationBlock(sourceBody, translatedBody, state) {
  const base = stripTranslationBlock(sourceBody);
  const fitted = fitTranslationBody(base, translatedBody, state);
  const next = base + buildTranslationBlock(fitted, state);
  if (next.length > ISSUE_BODY_MAX) {
    throw new Error("Translated issue body exceeds GitHub limit after truncation.");
  }
  return next;
}

function appendThrottleBlock(sourceBody, state) {
  const base = stripTranslationBlock(sourceBody);
  const next = base + buildThrottleBlock(state);
  if (next.length > ISSUE_BODY_MAX) {
    throw new Error("Issue body exceeds GitHub limit after throttle marker.");
  }
  return next;
}

function pruneRecent(recent, now, windowMs = 3_600_000) {
  const cutoff = now - windowMs;
  return (Array.isArray(recent) ? recent : []).filter(
    (ts) => typeof ts === "number" && ts > cutoff,
  );
}

function countRecentTranslations(recent, now, windowMs = 3_600_000) {
  return pruneRecent(recent, now, windowMs).length;
}

/**
 * Decide whether a new translation should run (rate limits + unchanged source).
 *
 * @returns {{ ok: true, sourceHash: string, recent: number[] } | { ok: false, reason: string }}
 */
function shouldTranslate({
  sourceTitle = "",
  sourceBody,
  priorState = null,
  now = Date.now(),
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  const title = String(sourceTitle || "").trim();
  const body = String(sourceBody || "").trim();
  const combined = `${title}\n${body}`.trim();
  const minChars = rateLimit.minSourceChars ?? DEFAULT_RATE_LIMIT.minSourceChars;

  if (combined.length < minChars) {
    return { ok: false, reason: "source_too_short" };
  }

  const sourceHash = hashSourceContent({ title, body });
  if (priorState?.sourceHash === sourceHash) {
    return { ok: false, reason: "unchanged_source" };
  }

  const minInterval = rateLimit.minIntervalMs ?? DEFAULT_RATE_LIMIT.minIntervalMs;
  const maxPerHour = rateLimit.maxPerHour ?? DEFAULT_RATE_LIMIT.maxPerHour;
  const translatedAt = typeof priorState?.translatedAt === "number" ? priorState.translatedAt : 0;
  const recent = pruneRecent(priorState?.recent, now);

  if (translatedAt && now - translatedAt < minInterval) {
    return { ok: false, reason: "rate_limited_interval" };
  }

  if (countRecentTranslations(recent, now) >= maxPerHour) {
    return { ok: false, reason: "rate_limited_hourly" };
  }

  return { ok: true, sourceHash, recent };
}

function nextTranslationState({ sourceHash, recent, now = Date.now() }) {
  const pruned = pruneRecent(recent, now);
  pruned.push(now);
  return {
    v: 1,
    sourceHash,
    translatedAt: now,
    recent: pruned,
  };
}

module.exports = {
  MARKER,
  ISSUE_BODY_MAX,
  DEFAULT_RATE_LIMIT,
  findTranslationBlockRange,
  hashSourceContent,
  hashSourceBody,
  extractTranslationState,
  stripTranslationBlock,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  buildTranslationBlock,
  buildThrottleBlock,
  maxTranslationChars,
  fitTranslationBody,
  appendTranslationBlock,
  appendThrottleBlock,
  shouldTranslate,
  nextTranslationState,
  countRecentTranslations,
  pruneRecent,
};
