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

function scrubString(value: string): string {
  let s = redactSecretString(value);
  s = s.replace(SECRETISH_GLOBAL, "[REDACTED]");
  // Strip absolute filesystem paths (coarse)
  s = s.replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|etc|root|mnt)\/)[^\s"']+/g, "[path]");
  // Strip URL userinfo / private hosts roughly
  s = s.replace(/https?:\/\/[^\s"']+/gi, (url) => {
    try {
      const u = new URL(url);
      if (u.username || u.password) return "[redacted-url]";
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(u.hostname)) {
        return `${u.protocol}//[private-host]${u.pathname}`;
      }
      return `${u.protocol}//[host]${u.pathname}`;
    } catch {
      return "[redacted-url]";
    }
  });
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength > MAX_SANITIZED_STRING_FIELD) {
    return new TextDecoder().decode(bytes.slice(0, MAX_SANITIZED_STRING_FIELD));
  }
  return s;
}

/** Stable privacy boundary for diagnostic text that may be persisted. */
export function sanitizeDiagnostic(value: unknown): string {
  return scrubString(value instanceof Error ? value.message : String(value));
}

export function sanitizedJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcsStringify(scrubValue(value, 0)));
}
