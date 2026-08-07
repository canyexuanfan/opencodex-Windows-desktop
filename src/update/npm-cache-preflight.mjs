import { lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmInvocation } from "./npm-invocation.mjs";

const WORKER_ARG = "--ocx-npm-cache-preflight-worker";
const PROTOCOL_VERSION = 1;
const WORKER_TIMEOUT_MS = 10_000;
const NPM_CONFIG_TIMEOUT_MS = 5_000;
const INSPECTION_TIMEOUT_MS = 7_500;
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;

const RESULT_REASONS = new Set([
  "cache_accessible",
  "cache_entry_foreign_owner",
  "cache_entry_inaccessible",
  "cache_path_malformed",
  "inspection_limit",
  "npm_config_failed",
  "npm_unavailable",
]);

function inaccessibleByMode(stat) {
  if (stat.isSymbolicLink()) return false;
  const ownerBits = stat.mode & 0o700;
  if (stat.isDirectory()) return (ownerBits & 0o700) !== 0o700;
  return (ownerBits & 0o400) === 0;
}

/**
 * Inspect an existing Unix npm cache without following symlinks. The limits are
 * deliberately part of the result contract: an incomplete inspection cannot prove
 * that replacing the live package will succeed.
 */
export function inspectNpmCacheDirectory(cachePath, options = {}) {
  const expectedUid = options.expectedUid ?? process.getuid?.();
  const deadline = (options.nowMs ?? Date.now)() + (options.timeoutMs ?? INSPECTION_TIMEOUT_MS);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const nowMs = options.nowMs ?? Date.now;
  const stack = [{ path: cachePath, depth: 0 }];
  let inspected = 0;

  while (stack.length > 0) {
    if (inspected >= maxEntries || nowMs() > deadline) {
      return { ok: false, reason: "inspection_limit" };
    }
    const current = stack.pop();
    let stat;
    try {
      stat = lstatSync(current.path);
    } catch (error) {
      if (current.depth === 0 && error?.code === "ENOENT") {
        return { ok: true, reason: "cache_accessible" };
      }
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    inspected += 1;

    if (expectedUid !== undefined && stat.uid !== expectedUid) {
      return { ok: false, reason: "cache_entry_foreign_owner" };
    }
    if (current.depth === 0 && stat.isSymbolicLink()) {
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    if (inaccessibleByMode(stat)) {
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    // Ownership was checked with lstat. Never follow a cache symlink: npm commonly
    // creates them below _npx/node_modules and .bin, and their targets are unrelated.
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (current.depth >= maxDepth) return { ok: false, reason: "inspection_limit" };

    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      return { ok: false, reason: "cache_entry_inaccessible" };
    }
    for (const entry of entries) {
      stack.push({ path: resolve(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return { ok: true, reason: "cache_accessible" };
}

function workerResult() {
  const invocation = npmInvocation(["config", "get", "cache"]);
  if (!invocation) return { ok: false, reason: "npm_unavailable" };
  const npm = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    timeout: NPM_CONFIG_TIMEOUT_MS,
    windowsHide: true,
    ...invocation.options,
  });
  if (npm.status !== 0) return { ok: false, reason: "npm_config_failed" };

  const output = typeof npm.stdout === "string" ? npm.stdout.trim() : "";
  if (!output || output.length > 4096 || output.includes("\0") || /[\r\n]/.test(output) || !isAbsolute(output)) {
    return { ok: false, reason: "cache_path_malformed" };
  }
  return inspectNpmCacheDirectory(output);
}

function parseWorkerOutput(stdout) {
  if (typeof stdout !== "string" || stdout.length > 1024) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || parsed.protocol !== PROTOCOL_VERSION || typeof parsed.ok !== "boolean") return null;
    if (typeof parsed.reason !== "string" || !RESULT_REASONS.has(parsed.reason)) return null;
    if (parsed.ok !== (parsed.reason === "cache_accessible")) return null;
    if (Object.keys(parsed).sort().join(",") !== "ok,protocol,reason") return null;
    return { ok: parsed.ok, reason: parsed.reason };
  } catch {
    return null;
  }
}

/** Run the bounded cache inspection in an isolated, synchronously-timeboxed worker. */
export function runNpmCachePreflight(options = {}) {
  if ((options.platform ?? process.platform) === "win32") {
    return { ok: true, reason: "windows_skip" };
  }
  const spawn = options.spawnSyncFn ?? spawnSync;
  const result = spawn(
    options.execPath ?? process.execPath,
    [fileURLToPath(import.meta.url), WORKER_ARG],
    {
      encoding: "utf8",
      timeout: options.timeoutMs ?? WORKER_TIMEOUT_MS,
      windowsHide: true,
      env: options.env ?? process.env,
    },
  );
  if (result.status === null) return { ok: false, reason: "worker_timeout" };
  if (result.status !== 0) return { ok: false, reason: "worker_failed" };
  return parseWorkerOutput(result.stdout) ?? { ok: false, reason: "worker_output_malformed" };
}

/** Fixed operator guidance; worker/npm output is intentionally never interpolated. */
export function npmCachePreflightFailureMessage(reason) {
  return `npm cache access pre-flight failed (${reason}); fix cache ownership and permissions, then retry`;
}

const isWorker = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && process.argv[2] === WORKER_ARG;
if (isWorker) {
  let result;
  try {
    result = workerResult();
  } catch {
    result = { ok: false, reason: "cache_entry_inaccessible" };
  }
  process.stdout.write(JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }));
}
