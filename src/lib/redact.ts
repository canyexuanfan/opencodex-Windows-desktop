export const REDACTED_SECRET = "[REDACTED]";

const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|set-cookie|set-cookie2|api[-_]?key|x-api-key|x-goog-api-key|x-amz-security-token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|profile[-_]?arn)$/i;

/**
 * Colon-labelled credential headers echoed back inside an error body
 * (`x-api-key: <value>`), which the `key=value` rules never match.
 *
 * This is one pass with an explicit decision rather than a stack of regexes
 * that have to reason about each other's output. Three earlier attempts failed
 * exactly there: exempting `Bearer` let anything the Bearer rule could not
 * parse escape both rules; trusting the public `[REDACTED]` marker let a
 * suffix ride along behind it; and splitting into two ordered patterns had the
 * second eat the first one's result.
 *
 * The rule: the value after the label is a credential and gets masked to
 * end-of-line. There is no "keep the readable part" exception, because every
 * round of review found another way to hide a credential inside whatever the
 * previous round chose to preserve — a second label, a repeated `Bearer`
 * scheme, a third token two levels deep. Preserving attacker-controlled text
 * next to a credential is the bug; the scheme word is not worth it.
 *
 * `Bearer` survives only as a fixed prefix on `authorization` /
 * `proxy-authorization`, where it says which scheme failed and carries nothing
 * from the input. `[REDACTED]` is a PUBLIC string an upstream can emit too, so
 * its presence never grants trust.
 *
 * The label boundary is matched over a NORMALIZED VIEW: colon confusables and
 * invisible format characters are folded for matching only, with offsets mapped
 * back so unrelated text keeps its original bytes. Folding the string itself
 * rewrote innocent diagnostics (`ratio∶1` became `ratio:1`).
 */
const CREDENTIAL_HEADER_LABEL = "x-api-key|x-goog-api-key|x-amz-security-token|api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|client[_-]?secret|clientSecret|authorization|proxy-authorization|cookie|set-cookie|password|secret|token";

/**
 * Characters that render as a colon separator. Folded to `:` in the matching
 * view so a look-alike cannot hide a header from the label pattern.
 */
const COLON_CONFUSABLES = new Set([
  "\uFF1A", "\uFE55", "\uFE13", "\uA789", "\u02D0", "\u2236",
  "\u205A", "\u0589", "\u1361", "\u16EC", "\u1803", "\u2982", "\u2AF6", "\uFE30",
]);

/**
 * Characters dropped from the matching view: anything with no visible width
 * that could split a label into pieces the pattern no longer recognizes.
 * `\p{Default_Ignorable_Code_Point}` is the systematic answer — it covers the
 * zero-width set, the bidi isolates and marks, the Mongolian vowel separator,
 * and the variation selectors in one property instead of a list that review
 * keeps finding another member of. `\p{Cf}` and combining marks are folded too.
 */
const INVISIBLE_FORMAT = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}\p{Me}]/u;

/**
 * Latin look-alikes for the ASCII letters that appear in credential labels.
 * Cyrillic `а`/`е`, Greek `ο`, fullwidth forms and the mathematical alphabets
 * all render as the label to a human, so the matching view folds them back.
 * NFKD handles the width/font variants; this table covers the cross-script
 * homoglyphs NFKD deliberately leaves alone.
 */
const LETTER_CONFUSABLES = new Map<string, string>([
  // Cyrillic
  ["\u0430", "a"], ["\u0435", "e"], ["\u043E", "o"], ["\u0440", "p"], ["\u0441", "c"],
  ["\u0445", "x"], ["\u0443", "y"], ["\u04BB", "h"], ["\u0455", "s"], ["\u0456", "i"],
  ["\u0458", "j"], ["\u043A", "k"], ["\u0442", "t"], ["\u0432", "b"], ["\u043C", "m"],
  ["\u043D", "h"], ["\u0501", "d"], ["\u0503", "g"], ["\u051B", "q"], ["\u051D", "w"],
  ["\u04CF", "l"], ["\u0261", "g"], ["\u04AB", "c"], ["\u04BD", "e"], ["\u0459", "k"],
  // Greek
  ["\u03B1", "a"], ["\u03BF", "o"], ["\u03C1", "p"], ["\u03BD", "v"], ["\u03BA", "k"],
  ["\u03B5", "e"], ["\u03C4", "t"], ["\u03B9", "i"], ["\u03C5", "u"], ["\u03C7", "x"],
  ["\u03B7", "n"], ["\u03BC", "u"], ["\u03C3", "o"], ["\u03B2", "b"], ["\u03B3", "y"],
  // Latin extended / other
  ["\u0131", "i"], ["\u0269", "i"], ["\u1D0F", "o"], ["\u0280", "r"], ["\u01BF", "p"],
  ["\u0578", "n"], ["\u057D", "u"], ["\u0585", "o"], ["\u0581", "g"], ["\u2044", "/"],
]);

// `\b` is the wrong left boundary for a header name: it matches after a `-` or
// `_`, so `not-authorization:` and `internal_token:` were treated as the
// credential labels they merely end with. Requiring a non-identifier character
// (or start of input) keeps the match to whole field names.
const COLON_LABELLED_CREDENTIAL = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${CREDENTIAL_HEADER_LABEL})[^\\S\\r\\n]*:`,
  "gi",
);

/**
 * Build a folded copy plus an index map back to the original string, so the
 * match runs on normalized text while the output keeps every byte the match did
 * not cover.
 */
function foldForMatching(value: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  // Iterate by CODE POINT, not UTF-16 code unit: a supplementary character
  // (mathematical letters, variation selectors above the BMP) is two units, so
  // a per-unit loop hands each half to the property tests separately and
  // neither half matches anything. `𝕩-api-key` and a U+E0100 inside a label
  // both walked straight past the fold that way.
  let i = 0;
  while (i < value.length) {
    const ch = String.fromCodePoint(value.codePointAt(i)!);
    const width = ch.length;
    if (INVISIBLE_FORMAT.test(ch)) {
      i += width;
      continue;
    }
    const mapped = COLON_CONFUSABLES.has(ch)
      ? ":"
      : LETTER_CONFUSABLES.get(ch.toLowerCase())
        // NFKD collapses fullwidth, circled, and mathematical letter variants
        // onto their ASCII base.
        ?? (ch.normalize("NFKD").length === 1 ? ch.normalize("NFKD") : ch);
    // One folded unit per source code point keeps the offset map aligned; a
    // multi-unit fold would desynchronize it, so those keep the original.
    folded += mapped.length === 1 ? mapped : ch;
    for (let k = 0; k < (mapped.length === 1 ? 1 : width); k += 1) map.push(i);
    i += width;
  }
  map.push(value.length);
  return { folded, map };
}

function maskCredentialHeaders(value: string): string {
  const { folded, map } = foldForMatching(value);
  COLON_LABELLED_CREDENTIAL.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = COLON_LABELLED_CREDENTIAL.exec(folded)) !== null) {
    const start = map[match.index] ?? value.length;
    const afterLabel = map[match.index + match[0].length] ?? value.length;
    if (start < cursor) continue;
    // Everything from the separator to end-of-line is the credential.
    const lineEnd = (() => {
      const nl = value.slice(afterLabel).search(/[\r\n]/);
      return nl === -1 ? value.length : afterLabel + nl;
    })();
    const rawValue = value.slice(afterLabel, lineEnd);
    if (!rawValue.trim()) continue;
    // Keep the original separator spacing so a diagnostic still reads as
    // `header: [REDACTED]` rather than `header:[REDACTED]`.
    const gap = /^[^\S\r\n]*/.exec(rawValue)?.[0] ?? "";
    // `Bearer` is a fixed prefix, reproduced from a literal — never copied from
    // the input — and only where an auth scheme is meaningful.
    const label = match[0].replace(/[^\S\r\n]*:$/, "").trim();
    const isAuthHeader = /^(?:proxy-)?authorization$/i.test(label);
    const prefix = isAuthHeader && /^[^\S\r\n]*Bearer[^\S\r\n]/i.test(rawValue) ? "Bearer " : "";
    out += value.slice(cursor, afterLabel) + gap + prefix + REDACTED_SECRET;
    cursor = lineEnd;
  }
  return out + value.slice(cursor);
}

const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  // A Bearer token outside a labelled header (prose, JSON fragments, logs).
  // Horizontal whitespace only: `\s+` crossed line boundaries and masked the
  // first word of the NEXT line when a header was quoted with a trailing break.
  [/\b(Bearer)([^\S\r\n]+)[A-Za-z0-9._~+/=-]{8,}\b/gi, `$1$2${REDACTED_SECRET}`],
  [/\b(sk-[A-Za-z0-9][A-Za-z0-9._-]{6,})\b/g, REDACTED_SECRET],
  // GitHub tokens (classic + fine-grained + OAuth/refresh): ghp_/gho_/ghu_/ghs_/ghr_/github_pat_.
  [/\b(gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED_SECRET],
  // GitHub Copilot API tokens: semicolon-joined k=v grammar starting with tid=…
  // (e.g. "tid=abc123;exp=1699999999;sku=copilot_pro;…:sig"). Redact the whole token —
  // a Bearer-prefix rule alone leaves the suffix intact.
  [/\btid=[A-Za-z0-9-]+(?:;[A-Za-z0-9_.-]+=[^;\s"']*)+(?::[A-Za-z0-9+/=_-]+)?/g, REDACTED_SECRET],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)=)([^&\s"',;]+)/gi, `$1${REDACTED_SECRET}`],
  [/((?:"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|refreshToken|accessToken|clientSecret|apiKey)"\s*:\s*"))([^"]+)(")/gi, `$1${REDACTED_SECRET}$3`],
  // Raw JSON "token" field values (Copilot token exchange bodies echo the credential here).
  [/(("token"\s*:\s*"))([^"]+)(")/gi, `$1${REDACTED_SECRET}$4`],
  [/\b(arn:aws:[A-Za-z0-9_-]+:[A-Za-z0-9-]*:\d{12}:[A-Za-z0-9_/:+=,.@-]+)\b/g, REDACTED_SECRET],
];

type HeaderRecord = Record<string, string | string[] | undefined>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactSecretString(value: string): string {
  let redacted = maskCredentialHeaders(value);
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretString(value);
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (value instanceof Date) return value;
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactSecrets(entryValue);
  }
  return result;
}

export function redactHeaders(headers: Headers | HeaderRecord): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    if (rawValue === undefined) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    result[key] = isSensitiveKey(key) ? REDACTED_SECRET : redactSecretString(value);
  }

  return result;
}

export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return redactSecretString(url.split("?")[0] ?? url);
  }
}

const USER_HOME_PATH_PATTERNS: Array<[RegExp, string]> = [
  // Windows: C:\Users\<name>\...  ->  C:\Users\[USER]\...
  [/([A-Za-z]:\\Users\\)[^\\/]+/gi, "$1[USER]"],
  // POSIX: /Users/<name>/... (macOS) and /home/<name>/... (Linux)
  [/(\/(?:Users|home)\/)[^/]+/gi, "$1[USER]"],
];

// Path segments whose name alone looks sensitive. Masked so a configured path
// cannot surface a secret-flavored substring in diagnostics or logs.
const SENSITIVE_SEGMENT_PATTERN = /(^|[\\/])([^\\/]*(?:secret|password|passwd|token|api[-_]?key|apikey|credential|email)[^\\/]*)(?=[\\/]|$)/gi;

/**
 * Mask the username segment of an absolute home path so diagnostics can print
 * paths without leaking the OS account name, and mask any path segment whose
 * name looks sensitive (token/secret/password/credential/email/...). Path-focused
 * and secret-safe: also runs {@link redactSecretString} for token-shaped values.
 */
export function redactUserPath(path: string): string {
  let masked = path;
  for (const [pattern, replacement] of USER_HOME_PATH_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  masked = masked.replace(SENSITIVE_SEGMENT_PATTERN, (_m, sep: string) => `${sep}[REDACTED]`);
  return redactSecretString(masked);
}
