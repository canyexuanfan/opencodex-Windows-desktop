"use strict";

const crypto = require("crypto");

const MARKER = "<!-- opencodex-issue-inline-translator -->";
const LEGACY_STATE_RE = /<!-- opencodex-issue-inline-translator-state:([\s\S]*?) -->\s*/;
const CONTROL_MARKER = "<!-- opencodex-issue-inline-translator-control -->";
const CONTROL_STATE_RE =
  /<!-- opencodex-issue-inline-translator-control-state:([\s\S]*?) -->/;
const ISSUE_BODY_MAX = 65536;
const BOT_LOGIN = "github-actions[bot]";

const DEFAULT_RATE_LIMIT = {
  minIntervalMs: 60_000,
  maxPerHour: 10,
  minSourceChars: 20,
};

/**
 * Deterministic fingerprint of the original issue source (title + stripped body).
 */
function hashTranslationSource({ title = "", body = "" } = {}) {
  const payload = [
    "title:",
    String(title || ""),
    "\nbody:\n",
    String(body || ""),
  ].join("");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/** @deprecated Use hashTranslationSource */
function hashSourceContent(args) {
  return hashTranslationSource(args);
}

/** @deprecated Use hashTranslationSource */
function hashSourceBody(body) {
  return hashTranslationSource({ body });
}

/**
 * Locate the first generated inline translation block.
 * @returns {{ start: number, end: number } | null}
 */
function findTranslationBlockRange(text) {
  const markerIdx = String(text || "").indexOf(MARKER);
  if (markerIdx === -1) return null;

  let cursor = markerIdx + MARKER.length;
  const afterMarker = String(text).slice(cursor);
  const legacyState = afterMarker.match(/^\s*<!-- opencodex-issue-inline-translator-state:[\s\S]*? -->\s*/);
  if (legacyState) {
    cursor += legacyState.index + legacyState[0].length;
  }

  const rest = String(text).slice(cursor);
  if (/^\s*<details>/i.test(rest)) {
    const closeRel = rest.search(/<\/details>/i);
    if (closeRel !== -1) {
      return { start: markerIdx, end: cursor + closeRel + "</details>".length };
    }
    return { start: markerIdx, end: cursor };
  }

  if (legacyState) {
    return { start: markerIdx, end: cursor };
  }

  return { start: markerIdx, end: markerIdx + MARKER.length };
}

/**
 * Split an issue body into user prefix/suffix and the generated translation block.
 */
function splitTranslationBlock(body) {
  const text = String(body || "");
  const range = findTranslationBlockRange(text);
  if (!range) {
    const sourceBody = text.replace(/\s+$/, "");
    return {
      found: false,
      prefix: sourceBody,
      block: "",
      suffix: "",
      sourceBody,
    };
  }

  const prefix = text.slice(0, range.start).replace(/\s+$/, "");
  const block = text.slice(range.start, range.end);
  const suffix = text.slice(range.end).replace(/^\s+/, "");
  const sourceBody = suffix
    ? (prefix ? `${prefix}\n\n${suffix}` : suffix).replace(/\s+$/, "")
    : prefix;

  return { found: true, prefix, block, suffix, sourceBody };
}

function stripTranslationBlock(body) {
  return splitTranslationBlock(body).sourceBody;
}

/** Legacy body-embedded state (ignored for rate limits). */
function extractTranslationState(body) {
  const match = String(body || "").match(LEGACY_STATE_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseControlState(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function extractTranslationControlState(comments) {
  const botComments = (Array.isArray(comments) ? comments : []).filter(
    (comment) => comment?.user?.login === BOT_LOGIN && comment?.body?.includes(CONTROL_MARKER),
  );
  if (!botComments.length) return null;

  const newest = botComments[botComments.length - 1];
  const match = String(newest.body || "").match(CONTROL_STATE_RE);
  return parseControlState(match?.[1]);
}

function buildTranslationControlComment(state) {
  const stateJson = JSON.stringify(state);
  return [
    CONTROL_MARKER,
    `<!-- opencodex-issue-inline-translator-control-state:${stateJson} -->`,
  ].join("\n");
}

function pruneRecent(recent, now, windowMs = 3_600_000) {
  const cutoff = now - windowMs;
  return (Array.isArray(recent) ? recent : []).filter(
    (ts) => typeof ts === "number" && ts > cutoff,
  );
}

function countRecentAttempts(recent, now, windowMs = 3_600_000) {
  return pruneRecent(recent, now, windowMs).length;
}

function mergeTranslationAttemptState({ priorState = null, attempt, now = Date.now() }) {
  if (priorState?.attemptedAt && priorState.attemptedAt > now) {
    return priorState;
  }

  const priorRecent = pruneRecent(priorState?.recent, now);
  const recent = pruneRecent([...priorRecent, now], now);

  return {
    v: 2,
    sourceHash: attempt.sourceHash,
    attemptedAt: now,
    recent,
    requiresTranslation: Boolean(attempt.requiresTranslation),
    detectedLanguage: attempt.detectedLanguage ?? null,
  };
}

function isPreparedSourceStillCurrent({ preparedHash, liveTitle, liveBody }) {
  const liveHash = hashTranslationSource({
    title: liveTitle || "",
    body: liveBody || "",
  });
  return liveHash === preparedHash;
}

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

  const sourceHash = hashTranslationSource({ title, body });
  if (priorState?.sourceHash === sourceHash) {
    return { ok: false, reason: "unchanged_source" };
  }

  const minInterval = rateLimit.minIntervalMs ?? DEFAULT_RATE_LIMIT.minIntervalMs;
  const maxPerHour = rateLimit.maxPerHour ?? DEFAULT_RATE_LIMIT.maxPerHour;
  const attemptedAt = typeof priorState?.attemptedAt === "number" ? priorState.attemptedAt : 0;
  const recent = pruneRecent(priorState?.recent, now);

  if (attemptedAt && now - attemptedAt < minInterval) {
    return { ok: false, reason: "rate_limited_interval" };
  }

  if (countRecentAttempts(recent, now) >= maxPerHour) {
    return { ok: false, reason: "rate_limited_hourly" };
  }

  return { ok: true, sourceHash, recent };
}

/** @deprecated Use mergeTranslationAttemptState */
function nextTranslationState({ sourceHash, recent, now = Date.now() }) {
  return mergeTranslationAttemptState({
    priorState: null,
    attempt: { sourceHash, requiresTranslation: true, detectedLanguage: null, recent },
    now,
  });
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

function buildTranslationBlock(translatedBody) {
  const safeBody = sanitizeTranslationBody(translatedBody);
  return [
    "",
    MARKER,
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

function maxTranslationChars(sourceBody) {
  const base = stripTranslationBlock(sourceBody);
  const emptyBlock = buildTranslationBlock("");
  return Math.max(0, ISSUE_BODY_MAX - base.length - emptyBlock.length - 64);
}

function fitTranslationBody(sourceBody, translatedBody) {
  let safe = sanitizeTranslationBody(translatedBody);
  const maxChars = maxTranslationChars(sourceBody);
  if (safe.length <= maxChars) return safe;
  const note = "\n\n_(Translation truncated to fit GitHub issue body limit.)_";
  const budget = Math.max(0, maxChars - note.length);
  return safe.slice(0, budget).trimEnd() + note;
}

function appendTranslationBlock(sourceBody, translatedBody) {
  const base = stripTranslationBlock(sourceBody);
  const fitted = fitTranslationBody(base, translatedBody);
  const next = base + buildTranslationBlock(fitted);
  if (next.length > ISSUE_BODY_MAX) {
    throw new Error("Translated issue body exceeds GitHub limit after truncation.");
  }
  return next;
}

module.exports = {
  MARKER,
  CONTROL_MARKER,
  BOT_LOGIN,
  ISSUE_BODY_MAX,
  DEFAULT_RATE_LIMIT,
  hashTranslationSource,
  hashSourceContent,
  hashSourceBody,
  findTranslationBlockRange,
  splitTranslationBlock,
  stripTranslationBlock,
  extractTranslationState,
  extractTranslationControlState,
  buildTranslationControlComment,
  mergeTranslationAttemptState,
  isPreparedSourceStillCurrent,
  shouldTranslate,
  nextTranslationState,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  buildTranslationBlock,
  maxTranslationChars,
  fitTranslationBody,
  appendTranslationBlock,
  pruneRecent,
  countRecentAttempts,
};
