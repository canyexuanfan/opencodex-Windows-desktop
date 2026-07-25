"use strict";

/**
 * Parse + harden duplicate/related triage model output.
 * Related matches are high-noise; prefer empty over weak overlap.
 */

const WEAK_RELATED_REASON_RE =
  /\b(?:somewhat|broadly|loosely|vaguely)\s+related\b|\bboth\s+(?:issues?\s+)?pertain\s+to\s+errors?\b|\bsame\s+(?:client|app)\b|\berrors?\s+in\s+general\b|\bgeneral\s+proxy\s+errors?\b|\bHTTP\s+error\b/i;

/**
 * Positive evidence that two issues share a concrete failure signature.
 * Generic wording like "same client" is not enough by itself.
 */
function hasConcreteRelatedSignature(reason) {
  const text = String(reason || "");
  if (!text) return false;

  if (/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN)\b/i.test(text)) {
    return true;
  }
  // Exact HTTP status paired with an API path.
  if (/\b(?:exact\s+)?(?:HTTP\s+)?([1-5]\d\d)\b/i.test(text) && /\/v\d\//.test(text)) {
    return true;
  }
  if (/\bPOST\s+\/v\d\//i.test(text) || /\/v\d\/[\w./_-]+/.test(text)) {
    return true;
  }
  // Provider/adapter path with a concrete failure token.
  if (
    /\b(?:openai-chat|anthropic|openrouter|google|xiaomi|adapter)\b/i.test(text)
    && /\b(?:\d{3}|E[A-Z]{3,}|fail|error|reset|timeout)\b/i.test(text)
  ) {
    return true;
  }
  // Structured field / content-path failures.
  if (/\bcontent\[\d+\]/.test(text) || /\b[\w]+\.[\w.]+\.(?:text|content|type)\b/.test(text)) {
    return true;
  }
  if (/\bField required\b/i.test(text)) return true;
  // Concrete reproduction clause.
  if (/\breproduc(?:e|es|ed|tion)\b/i.test(text) && /\b(?:when|if|after|on)\b/i.test(text)) {
    return true;
  }
  // Platform-specific listen/port reclaim fingerprints.
  if (/\b(?:taskkill|ghost\s+LISTEN|listen(?:-|\s)?port)\b/i.test(text) && /\b\d{2,5}\b/.test(text)) {
    return true;
  }
  return false;
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

function normalizeIssueNumbers(value, { currentNumber, knownNumbers }) {
  const cur = String(currentNumber);
  const known = knownNumbers instanceof Set
    ? knownNumbers
    : new Set((knownNumbers || []).map(String));
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => {
        const match = String(entry).trim().match(/^#?(\d+)$/);
        return match ? match[1] : "";
      })
      .filter((number) => number && number !== cur && known.has(number)),
  )];
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
 * Drop related matches when the model only found a soft / generic overlap.
 * Concrete shared failure signatures keep related matches even if the reason
 * also says "same client" / "same app".
 */
function hardenRelatedMatches({ duplicates, related, reason }) {
  const dupes = Array.isArray(duplicates) ? duplicates : [];
  let relatedList = Array.isArray(related) ? related.filter((n) => !dupes.includes(n)) : [];
  const safeReason = sanitizeReason(reason);

  if (!relatedList.length) {
    return { duplicates: dupes, related: [], reason: safeReason };
  }

  const weak = WEAK_RELATED_REASON_RE.test(safeReason);
  const concrete = hasConcreteRelatedSignature(safeReason);
  if ((weak && !concrete) || !concrete) {
    // Related without a concrete shared signature is not actionable.
    relatedList = [];
  }

  // Related without a concrete reason is not actionable — drop it.
  if (relatedList.length && (!safeReason || safeReason.length < 24)) {
    relatedList = [];
  }

  return {
    duplicates: dupes,
    related: relatedList.slice(0, 3),
    reason: safeReason,
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

  const related = normalizeIssueNumbers(parsed.related, {
    currentNumber,
    knownNumbers,
  })
    .filter((n) => !duplicates.includes(n))
    .slice(0, 5);

  const hardened = hardenRelatedMatches({
    duplicates,
    related,
    reason: parsed.reason,
  });

  if (!hardened.duplicates.length && !hardened.related.length) {
    return null;
  }

  return {
    duplicates: hardened.duplicates,
    related: hardened.related,
    reason: hardened.reason || "Potential matches returned without a reason.",
  };
}

module.exports = {
  WEAK_RELATED_REASON_RE,
  hasConcreteRelatedSignature,
  sanitizeReason,
  normalizeIssueNumbers,
  parseAiJson,
  hardenRelatedMatches,
  parseTriageMatches,
};
