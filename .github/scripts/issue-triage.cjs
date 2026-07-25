"use strict";

/**
 * Parse + harden duplicate/related triage model output.
 * Related matches are high-noise; prefer empty over weak overlap.
 * Each related entry must carry its own concrete shared-failure reason.
 */

const WEAK_RELATED_REASON_RE =
  /\b(?:somewhat|broadly|loosely|vaguely)\s+related\b|\bboth\s+(?:issues?\s+)?pertain\s+to\s+errors?\b|\bsame\s+(?:client|app)\b|\berrors?\s+in\s+general\b|\bgeneral\s+proxy\s+errors?\b|\bHTTP\s+error\b/i;

/** Explicit comparison that the two issues share a failure (not just overlap). */
const SHARED_COMPARISON_RE =
  /\b(?:both(?:\s+issues?)?\s+(?:return|report|show|have|hit|fail|use|call|involve|reproduce|receive)|(?:the\s+)?same\s+(?:error|failure|status|fault|exception|signature|root\s+cause)|shared\s+(?:failure|error|status|signature)|identical(?:ly)?)\b/i;

/** Reasons that admit the failures are not actually shared. */
const DIVERGENT_FAILURE_RE =
  /\b(?:but\s+(?:one|the\s+other|they)|one\s+returns|the\s+other(?:\s+\w+)?\s+(?:returns|crashes|fails|reports)|failures?\s+and\s+root\s+causes\s+differ|(?:failures?|root\s+causes?|status(?:es)?|errors?)\s+differ|different\s+(?:failure|root\s+cause|status|error|problem)|separate\s+\d{3}\s+problem|alone\s+reports)\b/i;

/** Well-known errno / syscall failure tokens (case-sensitive uppercase form preferred). */
const KNOWN_ERRNO_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EADDRINUSE)\b/;

/**
 * Errno-style tokens must be uppercase E + 4+ uppercase letters so ordinary
 * English words (each, exact, existing) never match.
 */
const ERRNO_STYLE_RE = /\bE[A-Z]{4,}\b/;

function hasConcreteFailureToken(text) {
  if (KNOWN_ERRNO_RE.test(text) || ERRNO_STYLE_RE.test(text)) return true;
  if (/\b(?:HTTP\s+)?[1-5]\d\d\b/i.test(text)) return true;
  if (/\bcontent\[\d+\]/.test(text) || /\b[\w]+\.[\w.]+\.(?:text|content|type)\b/.test(text)) {
    return true;
  }
  if (/\bField required\b/i.test(text)) return true;
  if (/\breproduc(?:e|es|ed|tion)\b/i.test(text) && /\b(?:when|if|after|on)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:taskkill|ghost\s+LISTEN|listen(?:-|\s)?port)\b/i.test(text) && /\b\d{2,5}\b/.test(text)) {
    return true;
  }
  return false;
}

/**
 * Positive evidence that two issues share a concrete failure signature.
 * Requires explicit shared-comparison language plus a concrete failure token.
 * API routes / providers alone are never enough.
 */
function hasConcreteRelatedSignature(reason) {
  const text = String(reason || "");
  if (!text) return false;
  if (!SHARED_COMPARISON_RE.test(text)) return false;
  if (DIVERGENT_FAILURE_RE.test(text)) return false;
  if (!hasConcreteFailureToken(text)) return false;
  // Weak client/app overlap still needs a real shared failure token (already required).
  // Route-only / provider-only claims never reach here without a failure token.
  return true;
}

function sanitizeReason(raw) {
  return String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@/g, "\0AT\0")
    .replace(/[`*_~<>[\]()#|]/g, "")
    .replace(/\0AT\0/g, "(at)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeIssueNumber(entry, { currentNumber, knownNumbers }) {
  const cur = String(currentNumber);
  const known = knownNumbers instanceof Set
    ? knownNumbers
    : new Set((knownNumbers || []).map(String));
  const match = String(entry ?? "").trim().match(/^#?(\d+)$/);
  if (!match) return "";
  const number = match[1];
  if (!number || number === cur || !known.has(number)) return "";
  return number;
}

function normalizeIssueNumbers(value, { currentNumber, knownNumbers }) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => normalizeIssueNumber(entry, { currentNumber, knownNumbers }))
      .filter(Boolean),
  )];
}

/**
 * Prefer per-entry {number, reason}. Bare issue-number strings are ignored
 * (shared top-level reasons are ambiguous across multiple related IDs).
 */
function normalizeRelatedEntries(value, { currentNumber, knownNumbers }) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    let number = "";
    let reason = "";
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      number = normalizeIssueNumber(entry.number ?? entry.issue ?? entry.id, {
        currentNumber,
        knownNumbers,
      });
      reason = sanitizeReason(entry.reason ?? entry.why ?? "");
    } else {
      // Legacy string / number forms have no per-entry reason — drop them.
      continue;
    }
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, reason });
  }
  return out;
}

function parseAiJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(
        text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim(),
      );
    } catch {
      return null;
    }
  }
}

/**
 * Validate each related entry independently.
 * Weak shared-client wording without a concrete shared failure is dropped.
 */
function hardenRelatedMatches({ duplicates, related }) {
  const dupes = Array.isArray(duplicates) ? duplicates : [];
  const dupeSet = new Set(dupes.map(String));
  const relatedOut = [];

  for (const entry of Array.isArray(related) ? related : []) {
    const number = String(entry?.number || "");
    if (!number || dupeSet.has(number)) continue;
    const safeReason = sanitizeReason(entry?.reason);
    if (!safeReason || safeReason.length < 24) continue;
    if (WEAK_RELATED_REASON_RE.test(safeReason) && !hasConcreteRelatedSignature(safeReason)) {
      continue;
    }
    if (!hasConcreteRelatedSignature(safeReason)) continue;
    relatedOut.push({ number, reason: safeReason });
    if (relatedOut.length >= 3) break;
  }

  return {
    duplicates: dupes,
    related: relatedOut,
  };
}

function parseTriageMatches(raw, { currentNumber, knownNumbers }) {
  const parsed = parseAiJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const duplicates = normalizeIssueNumbers(parsed.duplicates ?? parsed.issues, {
    currentNumber,
    knownNumbers,
  }).slice(0, 5);

  const relatedEntries = normalizeRelatedEntries(parsed.related, {
    currentNumber,
    knownNumbers,
  }).filter((entry) => !duplicates.includes(entry.number));

  const hardened = hardenRelatedMatches({
    duplicates,
    related: relatedEntries,
  });

  const overallReason = sanitizeReason(parsed.reason);

  if (!hardened.duplicates.length && !hardened.related.length) {
    return null;
  }

  return {
    duplicates: hardened.duplicates,
    related: hardened.related,
    reason: overallReason || "Potential matches returned without a reason.",
  };
}

module.exports = {
  WEAK_RELATED_REASON_RE,
  SHARED_COMPARISON_RE,
  DIVERGENT_FAILURE_RE,
  hasConcreteRelatedSignature,
  hasConcreteFailureToken,
  sanitizeReason,
  normalizeIssueNumber,
  normalizeIssueNumbers,
  normalizeRelatedEntries,
  parseAiJson,
  hardenRelatedMatches,
  parseTriageMatches,
};
