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
 * The rule: the value after the colon is a credential and gets masked whole.
 * `Bearer` is the single exception — an auth scheme is diagnostically useful,
 * and its token is one opaque word — so the scheme is kept and exactly that
 * word is consumed, leaving trailing prose (`… at /path/file.json`) readable.
 * `[REDACTED]` is a PUBLIC string an upstream can emit too, so its presence
 * never grants trust.
 *
 * The preserved remainder is RE-SCANNED, because "the rest is prose" is an
 * assumption the input controls: `Authorization: Bearer <tok> x-api-key: <tok2>`
 * and `Authorization: Bearer Bearer <tok>` both hid a second credential in what
 * the first pass treated as trailing text.
 *
 * Colon confusables are normalized for MATCHING only. A full-width `：` or a
 * small/vertical form reads as a colon to a human and to whatever produced the
 * error body, so accepting only ASCII `:` was a bypass, not a strictness.
 */
const CREDENTIAL_HEADER_LABEL = "x-api-key|x-goog-api-key|x-amz-security-token|api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|client[_-]?secret|clientSecret|authorization|proxy-authorization|cookie|set-cookie|password|secret|token";

/** Colon confusables that render as a separator: full-width, small, vertical, modifier. */
const COLON_CONFUSABLES = /[\uFF1A\uFE55\uFE13\uA789\u02D0\u2236]/g;

const COLON_LABELLED_CREDENTIAL = new RegExp(
  `\\b((?:${CREDENTIAL_HEADER_LABEL})[^\\S\\r\\n]*:[^\\S\\r\\n]*)([^\\r\\n]+)`,
  "gi",
);

function maskColonLabelledCredential(_match: string, label: string, value: string): string {
  // The Bearer carve-out exists for `Authorization`-style headers, where the
  // scheme is real and worth reading. On `x-api-key` or `cookie` the word
  // carries no meaning, so honoring it there just hands an attacker a way to
  // keep part of the line: `x-api-key: Bearer first <secret>` used to survive.
  const bearer = /^authorization$/i.test(label.replace(/[^\S\r\n]*:[^\S\r\n]*$/, "").trim())
    || /^proxy-authorization$/i.test(label.replace(/[^\S\r\n]*:[^\S\r\n]*$/, "").trim())
    ? /^(Bearer[^\S\r\n]+)(\S+)([^\r\n]*)$/i.exec(value)
    : null;
  if (!bearer) return `${label}${REDACTED_SECRET}`;
  // A repeated scheme word means the NEXT token is the credential, not this
  // one: `Bearer Bearer <tok>` would otherwise mask the literal word "Bearer"
  // and hand the real token back as prose.
  if (/^Bearer$/i.test(bearer[2] ?? "")) return `${label}${bearer[1]}${REDACTED_SECRET}`;
  // Keep the scheme word and mask its token, then scan the remainder ONE level
  // for further labels. The outer match consumed the whole line, so nothing
  // else will revisit this text. Depth is capped rather than recursive: a
  // per-match recursion blew the stack on a line with thousands of repeated
  // headers.
  return `${label}${bearer[1]}${REDACTED_SECRET}${maskRemainder(bearer[3] ?? "")}`;
}

/** Single-level rescan of text a Bearer match preserved as "prose". */
function maskRemainder(value: string): string {
  if (!value) return value;
  return value.replace(COLON_LABELLED_CREDENTIAL, (_m, label: string, rest: string) => {
    const nested = /^(Bearer[^\S\r\n]+)(\S+)([^\r\n]*)$/i.exec(rest);
    if (nested && /^authorization$/i.test(label.replace(/[^\S\r\n]*:[^\S\r\n]*$/, "").trim())) {
      return `${label}${nested[1]}${REDACTED_SECRET}`;
    }
    return `${label}${REDACTED_SECRET}`;
  });
}

function maskCredentialHeaders(value: string): string {
  let current = value.replace(COLON_CONFUSABLES, ":");
  // Bounded fixpoint over the whole string. Each pass masks at least one more
  // credential; the bound keeps a pathological input from spinning, and the
  // value patterns that run afterwards still cover anything left.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = current.replace(COLON_LABELLED_CREDENTIAL, maskColonLabelledCredential);
    if (next === current) return current;
    current = next;
  }
  return current;
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
