"use strict";

const crypto = require("crypto");

const MARKER = "<!-- opencodex-issue-inline-translator -->";
const STATE_RE = /<!-- opencodex-issue-inline-translator-state:([\s\S]*?) -->\s*/;
const BLOCK_RE =
  /\n*<!-- opencodex-issue-inline-translator -->[\s\S]*?<\/details>\s*$/i;

const DEFAULT_RATE_LIMIT = {
  minIntervalMs: 60_000,
  maxPerHour: 10,
  minSourceChars: 20,
};

/**
 * Fingerprint issue source text (without the inline translation block).
 */
function hashSourceBody(body) {
  return crypto.createHash("sha256").update(String(body || ""), "utf8").digest("hex").slice(0, 16);
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
 * Remove the inline translation block (marker, state, and details) from a body.
 */
function stripTranslationBlock(body) {
  let text = String(body || "");
  if (text.includes(MARKER)) {
    text = text.replace(BLOCK_RE, "");
  }
  return text.replace(/\s+$/, "");
}

function sanitizeTranslationBody(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@/g, "(at)")
    .replace(/\bjavascript:/gi, "")
    .trim()
    .slice(0, 60000);
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

/**
 * Build the collapsible translation appendix appended to an issue body.
 */
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

function appendTranslationBlock(sourceBody, translatedBody, state) {
  const base = stripTranslationBlock(sourceBody);
  return base + buildTranslationBlock(translatedBody, state);
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
  sourceBody,
  priorState = null,
  now = Date.now(),
  rateLimit = DEFAULT_RATE_LIMIT,
}) {
  const source = String(sourceBody || "").trim();
  const minChars = rateLimit.minSourceChars ?? DEFAULT_RATE_LIMIT.minSourceChars;

  if (source.length < minChars) {
    return { ok: false, reason: "source_too_short" };
  }

  const sourceHash = hashSourceBody(source);
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
  DEFAULT_RATE_LIMIT,
  hashSourceBody,
  extractTranslationState,
  stripTranslationBlock,
  sanitizeTranslationBody,
  scrubDetectedLanguage,
  buildTranslationBlock,
  appendTranslationBlock,
  shouldTranslate,
  nextTranslationState,
  countRecentTranslations,
  pruneRecent,
};
