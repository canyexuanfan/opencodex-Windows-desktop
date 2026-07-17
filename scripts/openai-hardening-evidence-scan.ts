import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const TOP_LEVEL_KEYS: Record<string, readonly string[]> = {
  "050_e2e.json": ["schemaVersion", "verdict", "publicNetworkFallback", "httpCases", "websocketTurns", "compactCases", "canonicalUrls", "migrationRestore", "virtualIdentity", "reverseInsertionOrder", "realClaudeStateUnchanged"],
  "050_client_history.json": ["schemaVersion", "verdict", "selectedModel", "modelProvider", "resolvedModel", "reasoningMode", "rolloutCount", "attempts"],
  "050_runtime_smoke.json": ["schemaVersion", "verdict", "instances", "distinctPids", "catalogReady", "direct", "multi", "apiPro", "clientHistoryVerified", "codexVersion", "userState", "liveKey"],
};
const LIVE_KEY_KEYS = ["status", "liveCalls", "outcomes"] as const;
const OUTCOME_KEYS = ["status", "requestId", "selectedId", "resolvedId"] as const;

function exactKeys(value: unknown, allowed: readonly string[], label: string, errors: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label}: expected object`);
    return false;
  }
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) errors.push(`${label}: unknown or missing keys`);
  return true;
}

export function evidenceDenyFindings(text: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["absolute-home", /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/],
    ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ["bearer", /Bearer\s+[A-Za-z0-9._-]+/i],
    ["api-key", /\bsk-[A-Za-z0-9_-]{12,}\b/],
    ["jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
    ["prompt", /(?:Reply exactly|"prompt"\s*:|"input"\s*:)/i],
    ["fixture-secret", /fixture-(?:api-key|codex-access|pool-access|refresh-token)/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

export function scanEvidence(paths: string[]): string[] {
  const errors: string[] = [];
  if (paths.length < 4 || paths.length > 5) errors.push("expected four artifacts and optional final audit");
  for (const path of paths) {
    const name = basename(path);
    if (!existsSync(path)) { errors.push(`${name}: missing`); continue; }
    const text = readFileSync(path, "utf8");
    if (!text.trim()) { errors.push(`${name}: empty`); continue; }
    for (const finding of evidenceDenyFindings(text)) errors.push(`${name}: ${finding}`);
    if (name === "051_audit_wp050_implementation.md") {
      if (!/VERDICT:\s*PASS/.test(text)) errors.push(`${name}: missing PASS verdict`);
      continue;
    }
    if (name === "050_gate_summary.txt") {
      if (!/^schemaVersion=1$/m.test(text) || !/^verdict=PASS$/m.test(text) || !/^command\[\d+\]=.+\|exit=0\|/m.test(text)) {
        errors.push(`${name}: invalid summary schema`);
      }
      continue;
    }
    const allowed = TOP_LEVEL_KEYS[name];
    if (!allowed) { errors.push(`${name}: unexpected artifact name`); continue; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { errors.push(`${name}: invalid JSON`); continue; }
    if (!exactKeys(value, allowed, name, errors)) continue;
    if (value.schemaVersion !== 1 || value.verdict !== "PASS") errors.push(`${name}: invalid version/verdict`);
    if (name === "050_e2e.json" && value.publicNetworkFallback !== false) errors.push(`${name}: network fallback must be false`);
    if (name === "050_client_history.json" && value.selectedModel !== "openai-apikey/gpt-5.6-sol-pro") errors.push(`${name}: wrong selected model`);
    if (name === "050_runtime_smoke.json") {
      if (!exactKeys(value.liveKey, LIVE_KEY_KEYS, `${name}.liveKey`, errors)) continue;
      if (![0, 2].includes(value.liveKey.liveCalls as number)) errors.push(`${name}: invalid liveCalls`);
      if (!Array.isArray(value.liveKey.outcomes)) errors.push(`${name}: outcomes must be an array`);
      else for (const [index, outcome] of value.liveKey.outcomes.entries()) exactKeys(outcome, OUTCOME_KEYS, `${name}.outcomes[${index}]`, errors);
      if (typeof value.liveKey.status !== "string" || !value.liveKey.status) errors.push(`${name}: missing live status`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = scanEvidence(Bun.argv.slice(2));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log("OpenAI hardening evidence scan passed");
}
