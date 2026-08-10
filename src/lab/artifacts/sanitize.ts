/**
 * Deny-by-default sanitization before artifact hashing/writing.
 * Never persists prompts, secrets, paths, account IDs, raw URLs, or provider bodies.
 */
import type { ArtifactClass } from "../constants";
import { MAX_SANITIZED_STRING_FIELD } from "../constants";
import { jcsStringify } from "../digest";
import { redactSecretString } from "../../lib/redact";

const FORBIDDEN_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|token|secret|password|email|prompt|messages|content|body|url|hostname|baseUrl|path|account|alias)$/i;
const SECRETISH = /sk-[a-z0-9]{10,}|Bearer\s+[A-Za-z0-9._\-]+|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/i;
const SECRETISH_GLOBAL = /sk-[a-z0-9]{10,}|Bearer\s+[A-Za-z0-9._\-]+|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/gi;

export function redactForArtifact(artifactClass: ArtifactClass, payload: unknown): unknown {
  if (
    artifactClass === "fixture" ||
    artifactClass === "scenario_manifest" ||
    artifactClass === "suite_manifest" ||
    artifactClass === "claim_source_manifest"
  ) {
    // Contract artifacts are already synthetic/canonical. Mutating them would
    // invalidate content-addressed digests; reject secret-shaped material instead.
    assertNoSecretMaterial(payload, 0);
    return payload;
  }
  return scrubValue(payload, 0);
}

const FORBIDDEN_CONTRACT_KEYS = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|token|secret|password|email|prompt|messages|baseUrl|hostname|account|alias)$/i;

function assertNoSecretMaterial(value: unknown, depth: number): void {
  if (depth > 8) {
    throw new Error("contract artifact exceeds sanitization inspection depth");
  }
  if (typeof value === "string") {
    if (SECRETISH.test(value)) {
      throw new Error("contract artifact contains forbidden secret-shaped material");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretMaterial(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as object)) {
      if (FORBIDDEN_CONTRACT_KEYS.test(key)) {
        throw new Error(`contract artifact forbids key ${key}`);
      }
      assertNoSecretMaterial(child, depth + 1);
    }
  }
}

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated_depth]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Uint8Array) {
    const text = new TextDecoder().decode(value);
    return new TextEncoder().encode(scrubString(text));
  }
  if (Array.isArray(value)) {
    if (value.length > 256) return value.slice(0, 256).map((v) => scrubValue(v, depth + 1));
    return value.map((v) => scrubValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object).slice(0, 64);
    for (const key of keys) {
      if (FORBIDDEN_KEY.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = scrubValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return "[unsupported]";
}

/**
 * Provider-controlled text can carry network and account identifiers that the
 * Compatibility Lab privacy contract forbids persisting. The rules below run in
 * a fixed total order; the order is load-bearing and documented in
 * `devlog/_plan/260810_release_train_and_triage/040_sec02_remediation.md`:
 *
 *   email before hostname   - else the hostname rule eats `example.com` in an address
 *   MAC before IPv6         - else `01:23:45:67:89:ab` matches as a mangled address
 *   IPv6 before IPv4        - else `::ffff:192.0.2.128` degrades to `::ffff:[ip]`
 *   HTTP before other URIs  - and the URI rule refuses http(s) so it cannot
 *                             re-match this rule's own `https://[host]/path` output
 *
 * Every rule replaces a value whole or not at all. A prefix replacement is
 * worse than no rule, because the output looks redacted while the tail leaks.
 */

/** Bounded, non-nested. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g;
const PREFIXED_ACCOUNT_RE = /\b(?:acct|cus|sub|org)[_-][A-Za-z0-9]{6,64}\b/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAC_RE = /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// `\b` does not fire between `_` and a digit, so `x_203.0.113.7` slipped past
// the word-boundary form above.
const UNDERSCORE_ADJACENT_IPV4_RE = /_((?:\d{1,3}\.){3}\d{1,3})\b/g;
// The final label allows digits and hyphens so a punycode TLD such as
// `xn--p1ai` is consumed whole; matching only `[a-z]{2,24}` stopped at the
// first hyphen and produced the partial `[host]--p1ai`.
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}[a-z][a-z0-9-]{1,31}\b/gi;
// The value is scanned to its delimiter, not to a word boundary: `\b` stops at
// the first `.` in `db_prod.internal`, which left `[host].internal` — a partial
// redaction that still names the host.
const HOST_CONTEXT_RE = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|host)[\s=]+([A-Za-z0-9_.-]{1,255})/g;
const ACCOUNT_LABEL_RE = /\b(?:user|account|org|tenant)(_?[iI]d)?\b/g;
const IDENTIFIER_ONLY_RE = /^[A-Za-z0-9_-]+$/;
const UNQUOTED_TERMINATOR = /[\s,;)\]}]/;

function isPrefixedAccount(value: string): boolean {
  PREFIXED_ACCOUNT_RE.lastIndex = 0;
  const m = PREFIXED_ACCOUNT_RE.exec(value);
  PREFIXED_ACCOUNT_RE.lastIndex = 0;
  return m?.[0] === value;
}

/**
 * A retained URL path keeps an error message diagnosable, but its segments are
 * provider-controlled: `/users/<uuid>` or `/orgs/acct_…` carries an account
 * identifier past the host rewrite. Replace whole segments that are an
 * identifier shape; leave route names alone.
 */
function scrubUrlPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      // Compare the decoded segment: `%2D` for `-` is still a UUID, and a
      // literal-only check let a percent-encoded identifier through.
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Malformed escapes: fall back to the raw segment.
      }
      if (UUID_RE.test(decoded) || isPrefixedAccount(decoded)) return "[account]";
      return segment;
    })
    .join("/");
}

/** Valid IPv4 dotted quad: every octet in range and canonically written. */
function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => p.length >= 1 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255);
}

/** Full IPv6 validation, including `::` compression and a trailing mapped IPv4. */
function isIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  let head = value;
  let tailGroups = 0;
  const lastColon = head.lastIndexOf(":");
  const afterLastColon = head.slice(lastColon + 1);
  if (afterLastColon.includes(".")) {
    if (!isIpv4(afterLastColon)) return false;
    head = head.slice(0, lastColon + 1);
    tailGroups = 2;
  } else if (head.includes(".")) {
    return false;
  }
  const doubleColons = head.split("::").length - 1;
  if (doubleColons > 1) return false;
  const compressed = doubleColons === 1;
  const [leftRaw = "", rightRaw = ""] = compressed ? head.split("::") : [head, ""];
  const splitGroups = (part: string): string[] | null => {
    if (part === "" || part === ":") return [];
    const trimmed = part.replace(/^:|:$/g, "");
    if (trimmed === "") return [];
    const groups = trimmed.split(":");
    return groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g)) ? groups : null;
  };
  const left = splitGroups(leftRaw);
  const right = compressed ? splitGroups(rightRaw) : [];
  if (left === null || right === null) return false;
  const total = left.length + right.length + tailGroups;
  return compressed ? total <= 7 : total === 8;
}

/**
 * Two-stage IPv6 replacement: scan the address alphabet, validate the base,
 * then extend the replaced span across an optional `%zone`. A single-alphabet
 * scan would leave `fe80::1%en0` as `[ip]%en0`.
 */
function redactIpv6(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (!/[0-9A-Fa-f:.]/.test(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let end = i;
    while (end < value.length && /[0-9A-Fa-f:.]/.test(value[end]!) && end - i < 45) end += 1;
    // The candidate alphabet includes `.` for IPv4-mapped forms, so a trailing
    // sentence period is swallowed too and `2001:db8::1.` failed validation as
    // a whole. Retry on progressively shorter prefixes so ordinary punctuation
    // after an address cannot defeat the rule.
    let matched = 0;
    for (let stop = end; stop > i; stop -= 1) {
      // A candidate may not end on `.` — that is sentence punctuation after an
      // address. It MAY end on `:`, because `2001:db8::` and `fe80::` are valid
      // compressed forms; rejecting every trailing colon skipped them entirely.
      // `isIpv6` is the arbiter, so a stray single trailing colon simply fails
      // validation and the loop backs off one more character.
      if (value[stop - 1] === ".") continue;
      if (isIpv6(value.slice(i, stop))) {
        matched = stop;
        break;
      }
    }
    if (matched > i) {
      let zoneEnd = matched;
      if (value[zoneEnd] === "%") {
        let z = zoneEnd + 1;
        while (z < value.length && /[A-Za-z0-9_.-]/.test(value[z]!) && z - zoneEnd <= 64) z += 1;
        if (z > zoneEnd + 1) zoneEnd = z;
      }
      out += "[ip]";
      i = zoneEnd;
      continue;
    }
    out += value.slice(i, end);
    i = end;
  }
  return out;
}

/** Scan a delimited span (UNC path, non-HTTP URI) and replace it whole. */
function redactScannedSpans(value: string, start: RegExp, token: string, accept?: (span: string) => boolean): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    start.lastIndex = i;
    const m = start.exec(value);
    if (!m) {
      out += value.slice(i);
      break;
    }
    let end = m.index + m[0].length;
    while (end < value.length && !/[\s"']/.test(value[end]!)) end += 1;
    const span = value.slice(m.index, end);
    out += value.slice(i, m.index);
    out += accept && !accept(span) ? span : token;
    i = end;
  }
  return out;
}

/**
 * Account identifiers under a label. The value span is resolved from its
 * syntax (quote pair, or run to a terminator) BEFORE it is validated, so an
 * out-of-grammar character or a missing closing quote leaves the text
 * untouched instead of producing a partially redacted prefix.
 *
 * ID-bearing labels (`user_id`, `accountId`, ...) redact any value of six or
 * more characters. Bare labels (`user`, `account`, ...) redact only an
 * unambiguous account shape, because `org: engineering` is ordinary prose.
 */
function redactContextualAccounts(value: string): string {
  let out = "";
  let cursor = 0;
  ACCOUNT_LABEL_RE.lastIndex = 0;
  let label: RegExpExecArray | null;
  while ((label = ACCOUNT_LABEL_RE.exec(value)) !== null) {
    if (label.index < cursor) continue;
    const idBearing = Boolean(label[1]);
    let p = label.index + label[0].length;
    // A JSON field name is quoted: `"userId": "v"`. Step over the label's own
    // closing quote before looking for the separator.
    if (value[p] === '"' || value[p] === "'") p += 1;
    while (p < value.length && /\s/.test(value[p]!)) p += 1;
    if (value[p] !== "=" && value[p] !== ":") continue;
    p += 1;
    while (p < value.length && /\s/.test(value[p]!)) p += 1;
    const quote = value[p] === '"' || value[p] === "'" ? value[p]! : "";
    let spanStart = quote ? p + 1 : p;
    let spanEnd: number;
    if (quote) {
      const close = value.indexOf(quote, spanStart);
      if (close === -1) continue;
      spanEnd = close;
    } else {
      spanEnd = spanStart;
      while (spanEnd < value.length && !UNQUOTED_TERMINATOR.test(value[spanEnd]!)) spanEnd += 1;
    }
    const span = value.slice(spanStart, spanEnd);
    if (!span || !IDENTIFIER_ONLY_RE.test(span)) continue;
    const redact = idBearing ? span.length >= 6 : isPrefixedAccount(span) || UUID_RE.test(span);
    if (!redact) continue;
    out += value.slice(cursor, spanStart) + "[account]";
    cursor = spanEnd;
    ACCOUNT_LABEL_RE.lastIndex = spanEnd;
  }
  out += value.slice(cursor);
  return out;
}

function scrubString(value: string): string {
  // 1. Existing secret redaction.
  let s = redactSecretString(value);
  s = s.replace(SECRETISH_GLOBAL, "[REDACTED]");
  // 2. Filesystem paths, including UNC shares.
  s = s.replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|etc|root|mnt)\/)[^\s"']+/g, "[path]");
  s = redactScannedSpans(s, /\\\\[^\\\s"']{1,255}\\/g, "[path]");
  // 3. HTTP(S) URLs. The retained pathname keeps the diagnostic useful, so its
  //    segments are scrubbed of identifier shapes rather than trusted: a
  //    provider error citing `/users/<uuid>` would otherwise persist an
  //    account id that the host rewrite alone does not touch.
  s = s.replace(/https?:\/\/[^\s"']+/gi, (url) => {
    try {
      const u = new URL(url);
      if (u.username || u.password) return "[redacted-url]";
      const path = scrubUrlPath(u.pathname);
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(u.hostname)) {
        return `${u.protocol}//[private-host]${path}`;
      }
      return `${u.protocol}//[host]${path}`;
    } catch {
      return "[redacted-url]";
    }
  });
  // 4. Other-scheme URIs, which may carry credentials. Refuses http(s) so it
  //    cannot re-match the output of rule 3.
  s = redactScannedSpans(s, /\b[a-z][a-z0-9+.-]{1,15}:\/\//gi, "[uri]", (span) => !/^https?:\/\//i.test(span));
  // 5-8. Bounded token shapes.
  s = s.replace(JWT_RE, "[jwt]");
  s = s.replace(EMAIL_RE, "[email]");
  s = s.replace(PREFIXED_ACCOUNT_RE, "[account]");
  s = redactContextualAccounts(s);
  s = s.replace(MAC_RE, "[mac]");
  // 9-10. Addresses: IPv6 first so mapped forms are replaced whole.
  s = redactIpv6(s);
  s = s.replace(IPV4_RE, (m) => (isIpv4(m) ? "[ip]" : m));
  s = s.replace(UNDERSCORE_ADJACENT_IPV4_RE, (m, ip: string) => (isIpv4(ip) ? m.replace(ip, "[ip]") : m));
  // 11. Multi-label hostnames, plus single-label names in a host-bearing context.
  s = s.replace(HOSTNAME_RE, "[host]");
  s = s.replace(HOST_CONTEXT_RE, (m, name: string) => m.replace(name, "[host]"));
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength > MAX_SANITIZED_STRING_FIELD) {
    return new TextDecoder().decode(bytes.slice(0, MAX_SANITIZED_STRING_FIELD));
  }
  return s;
}

const TRUNCATION_MARKERS = [
  "[REDACTED]",
  "[redacted-url]",
  "[private-host]",
  "[account]",
  "[email]",
  "[host]",
  "[path]",
  "[uri]",
  "[jwt]",
  "[mac]",
  "[ip]",
];

/**
 * Byte-bounded truncation for persisted summaries.
 *
 * `String.prototype.slice` counts UTF-16 code units, so it can split a
 * surrogate pair or leave a partial `[em` fragment that a reader could mistake
 * for literal content. Bytes are the right unit because
 * `enforceEventStructureLimits` also measures encoded byte length.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let cut = 0;
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).byteLength;
    if (used + size > maxBytes) break;
    used += size;
    cut += char.length;
  }
  // If the cut lands strictly inside a marker, drop the whole marker: a
  // fragment such as `[accoun` reads as literal content. Sanitization has
  // already replaced the raw value, so the marker's opening bracket is a safe
  // cut point and everything before it is intact.
  const open = value.lastIndexOf("[", cut - 1);
  if (open !== -1) {
    const tail = value.slice(open, cut);
    for (const marker of TRUNCATION_MARKERS) {
      if (tail.length < marker.length && marker.startsWith(tail)) return value.slice(0, open);
    }
  }
  return value.slice(0, cut);
}

/** Stable privacy boundary for diagnostic text that may be persisted. */
export function sanitizeDiagnostic(value: unknown): string {
  return scrubString(value instanceof Error ? value.message : String(value));
}

export function sanitizedJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcsStringify(scrubValue(value, 0)));
}
