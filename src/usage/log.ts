import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { usageDisplayTotalTokens } from "./totals";
import type { OcxUsage } from "../types";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

export type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "image-413";

export interface PersistedUsageAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  /** TTFT relative to THIS attempt's start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: UsageStatus;
  inputTokenEstimate?: number;
  usage?: OcxUsage;
  totalTokens?: number;
  errorCode?: string;
}

export interface PersistedUsageEntry {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  surface?: "claude" | "claude-desktop" | "grok";
  resolvedModel?: string;
  requestedModel?: string;
  /** Reasoning effort / service-tier metadata for GUI Logs after restart. */
  requestedEffort?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  status: number;
  durationMs: number;
  /** TTFT relative to the request start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  // Failure diagnostics (devlog/_plan/260716_claudecode_hardening/030): persisted for
  // status>=400 or non-completed terminals so incidents survive the in-memory ring buffer.
  errorCode?: string;
  terminalStatus?: string;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Already redacted + capped at capture (request-log.ts redactSecretString().slice(0,500)). */
  upstreamError?: string;
}

const KNOWN_USAGE_SURFACES = new Set<NonNullable<PersistedUsageEntry["surface"]>>([
  "claude",
  "claude-desktop",
  "grok",
]);

/**
 * The serializer guard for `surface`. Two failure modes shaped this: a literal
 * whitelist ("claude" | "claude-desktop" only) silently dropped every NEW surface at
 * write time, while a plain truthy spread would persist junk values from hand-edited
 * logs. Membership in this set is the middle path: adding a surface here is one edit,
 * and unknown values are still dropped.
 */
export function isKnownUsageSurface(value: unknown): value is NonNullable<PersistedUsageEntry["surface"]> {
  return typeof value === "string" && KNOWN_USAGE_SURFACES.has(value as NonNullable<PersistedUsageEntry["surface"]>);
}

export function usageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

export function usageTotalTokens(usage: OcxUsage | undefined): number | undefined {
  return usageDisplayTotalTokens(usage);
}

/**
 * Providers whose adapters can only estimate usage (no authoritative per-turn frame).
 * Callers should pass the route ADAPTER when available; the name-prefix match is a
 * fallback for paths that only know the configured provider name (e.g. "cursor-mykey").
 */
function isEstimatedUsageProvider(providerOrAdapter: string): boolean {
  return providerOrAdapter === "kiro" || providerOrAdapter.startsWith("kiro-")
    || providerOrAdapter === "cursor" || providerOrAdapter.startsWith("cursor-");
}

export function usageForFinalLog(provider: string, usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  if (usage.estimated || isEstimatedUsageProvider(provider)) return { ...usage, estimated: true };
  return usage;
}

export function usageStatusForFinalLog(usage: OcxUsage | undefined): UsageStatus {
  if (!usage) return "unreported";
  return usage.estimated ? "estimated" : "reported";
}

function normalizeUsageValue(usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(typeof usage.cacheReadInputTokens === "number" ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    ...(typeof usage.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
    ...(typeof usage.reasoningOutputTokens === "number" ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.estimated ? { estimated: true } : {}),
  };
}

const ATTEMPT_RECOVERY_KINDS = new Set<AttemptRecoveryKind>([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-429",
  "image-413",
]);
const USAGE_STATUSES = new Set<UsageStatus>([
  "reported",
  "unreported",
  "unsupported",
  "estimated",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeAttemptUsage(raw: unknown): OcxUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(usage.inputTokens)
    || !isNonNegativeFiniteNumber(usage.outputTokens)) return null;
  for (const key of [
    "totalTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (key in usage && !isNonNegativeFiniteNumber(usage[key])) return null;
  }
  if ("estimated" in usage && typeof usage.estimated !== "boolean") return null;
  return normalizeUsageValue(usage as unknown as OcxUsage) ?? null;
}

function normalizeUsageAttempt(raw: unknown): PersistedUsageAttempt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const attempt = raw as Record<string, unknown>;
  if (typeof attempt.ordinal !== "number" || !Number.isInteger(attempt.ordinal)
    || attempt.ordinal < 1
    || typeof attempt.provider !== "string" || !attempt.provider
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.adapter !== "string" || !attempt.adapter
    || typeof attempt.status !== "number" || !Number.isInteger(attempt.status)
    || attempt.status < 100 || attempt.status > 599
    || typeof attempt.durationMs !== "number" || !Number.isFinite(attempt.durationMs)
    || attempt.durationMs < 0
    || typeof attempt.sendCount !== "number" || !Number.isInteger(attempt.sendCount)
    || attempt.sendCount < 0
    || typeof attempt.usageStatus !== "string"
    || !USAGE_STATUSES.has(attempt.usageStatus as UsageStatus)) {
    return null;
  }
  if ("inputTokenEstimate" in attempt
    && !isNonNegativeFiniteNumber(attempt.inputTokenEstimate)) return null;
  if ("firstOutputMs" in attempt
    && !isNonNegativeFiniteNumber(attempt.firstOutputMs)) return null;
  if ("totalTokens" in attempt
    && !isNonNegativeFiniteNumber(attempt.totalTokens)) return null;
  const usage = "usage" in attempt ? normalizeAttemptUsage(attempt.usage) : undefined;
  if ("usage" in attempt && usage === null) return null;
  const recoveryKinds = Array.isArray(attempt.recoveryKinds)
    ? [...new Set(attempt.recoveryKinds.filter(
      (value): value is AttemptRecoveryKind => typeof value === "string"
        && ATTEMPT_RECOVERY_KINDS.has(value as AttemptRecoveryKind),
    ))]
    : [];
  return {
    ordinal: attempt.ordinal as number,
    provider: attempt.provider,
    model: attempt.model,
    adapter: attempt.adapter,
    status: attempt.status,
    durationMs: attempt.durationMs,
    ...(isNonNegativeFiniteNumber(attempt.firstOutputMs)
      ? { firstOutputMs: attempt.firstOutputMs }
      : {}),
    sendCount: attempt.sendCount as number,
    recoveryKinds,
    usageStatus: attempt.usageStatus as UsageStatus,
    ...(isNonNegativeFiniteNumber(attempt.inputTokenEstimate)
      ? { inputTokenEstimate: attempt.inputTokenEstimate }
      : {}),
    ...(usage ? { usage } : {}),
    ...(isNonNegativeFiniteNumber(attempt.totalTokens)
      ? { totalTokens: attempt.totalTokens }
      : {}),
    ...(typeof attempt.errorCode === "string" ? { errorCode: attempt.errorCode } : {}),
  };
}

function normalizedAttempts(raw: unknown): PersistedUsageAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUsageAttempt)
    .filter((attempt): attempt is PersistedUsageAttempt => attempt !== null);
}

const MAX_METADATA_STRING_LEN = 64;
function capMetadataString(s: string): string {
  return s.length > MAX_METADATA_STRING_LEN ? s.slice(0, MAX_METADATA_STRING_LEN) : s;
}

function normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  const attempts = normalizedAttempts(entry.attempts);
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(typeof entry.requestedEffort === "string" && entry.requestedEffort
      ? { requestedEffort: capMetadataString(entry.requestedEffort) }
      : {}),
    ...(typeof entry.requestedServiceTier === "string" && entry.requestedServiceTier
      ? { requestedServiceTier: capMetadataString(entry.requestedServiceTier) }
      : {}),
    ...(typeof entry.requestedSpeedLabel === "string" && entry.requestedSpeedLabel
      ? { requestedSpeedLabel: capMetadataString(entry.requestedSpeedLabel) }
      : {}),
    ...(typeof entry.configuredServiceTier === "string" && entry.configuredServiceTier
      ? { configuredServiceTier: capMetadataString(entry.configuredServiceTier) }
      : {}),
    ...(typeof entry.configuredSpeedLabel === "string" && entry.configuredSpeedLabel
      ? { configuredSpeedLabel: capMetadataString(entry.configuredSpeedLabel) }
      : {}),
    ...(typeof entry.modelSupportsServiceTier === "boolean"
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(typeof entry.responseServiceTier === "string" && entry.responseServiceTier
      ? { responseServiceTier: capMetadataString(entry.responseServiceTier) }
      : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    ...(isNonNegativeFiniteNumber(entry.firstOutputMs)
      ? { firstOutputMs: entry.firstOutputMs }
      : {}),
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: normalizeUsageValue(entry.usage) } : {}),
    ...(typeof entry.totalTokens === "number" ? { totalTokens: entry.totalTokens } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
    ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
    ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
  };
}

function ensureUsageLogDir(): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(normalizeUsageEntry(entry))}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
}

type UsageReadCache = {
  path: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  endedWithNewline: boolean;
  tailSignature: Buffer;
  entries: PersistedUsageEntry[];
};

const USAGE_CACHE_SIGNATURE_BYTES = 64;
let usageReadCache: UsageReadCache | null = null;
let usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
let managementUsageReadInflight: { path: string; promise: Promise<PersistedUsageEntry[]> } | null = null;

/** Test-only observability for proving that unchanged prefixes are not reparsed. */
export function usageReadCacheStatsForTests(): Readonly<typeof usageReadCacheStats> {
  return { ...usageReadCacheStats };
}

export function resetUsageReadCacheForTests(): void {
  usageReadCache = null;
  usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
  managementUsageReadInflight = null;
}

function parseUsageText(text: string): PersistedUsageEntry[] {
  const lines = text.split(/\r?\n/);
  usageReadCacheStats.parsedLines += lines.filter(line => line.trim()).length;
  return parseUsageLines(lines);
}

function sameUsageFile(cache: UsageReadCache, stat: ReturnType<typeof fstatSync>): boolean {
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  if (cache.dev !== dev) return false;
  // Node exposes a stable inode on the supported Windows and Unix runtimes. Keep a
  // birth-time fallback for filesystems that report zero for every inode.
  if (cache.ino !== 0 || ino !== 0) return cache.ino === ino;
  return cache.birthtimeMs === Number(stat.birthtimeMs);
}

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, output, offset, length - offset, position + offset);
    if (read === 0) return null;
    offset += read;
  }
  return output;
}

function usageTailSignature(bytes: Buffer): Buffer {
  return bytes.subarray(Math.max(0, bytes.length - USAGE_CACHE_SIGNATURE_BYTES)).subarray(0);
}

function readUsageEntriesFull(path: string, fd: number, stat: ReturnType<typeof fstatSync>): PersistedUsageEntry[] {
  const size = Number(stat.size);
  const bytes = readExactly(fd, size, 0);
  if (bytes === null) {
    usageReadCache = null;
    return [];
  }
  const entries = parseUsageText(bytes.toString("utf-8"));
  usageReadCacheStats.fullReads += 1;
  usageReadCache = {
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtimeMs: Number(stat.birthtimeMs),
    size,
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    endedWithNewline: bytes.length === 0 || bytes[bytes.length - 1] === 0x0a,
    tailSignature: usageTailSignature(bytes),
    entries,
  };
  return entries.slice();
}

async function parseUsageTextCooperatively(text: string): Promise<PersistedUsageEntry[]> {
  const lines = text.split(/\r?\n/);
  usageReadCacheStats.parsedLines += lines.filter(line => line.trim()).length;
  const entries: PersistedUsageEntry[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    entries.push(...parseUsageLines(lines.slice(offset, offset + batchSize)));
    if (offset + batchSize < lines.length) {
      // JSON parsing dominates large-log startup. Yield between bounded batches so
      // Bun can continue serving health and settings requests on the same thread.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return entries;
}

async function readUsageEntriesFullCooperatively(path: string): Promise<PersistedUsageEntry[]> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    const bytes = readExactly(fd, size, 0);
    if (bytes === null) return [];
    const entries = await parseUsageTextCooperatively(bytes.toString("utf-8"));
    usageReadCacheStats.fullReads += 1;
    // A different OPENCODEX_HOME may have become active while the cooperative parse
    // yielded. Return this snapshot to its caller without poisoning the new path cache.
    if (usageLogPath() === path) {
      usageReadCache = {
        path,
        dev: Number(stat.dev),
        ino: Number(stat.ino),
        birthtimeMs: Number(stat.birthtimeMs),
        size,
        mtimeMs: Number(stat.mtimeMs),
        ctimeMs: Number(stat.ctimeMs),
        endedWithNewline: bytes.length === 0 || bytes[bytes.length - 1] === 0x0a,
        tailSignature: usageTailSignature(bytes),
        entries,
      };
    }
    return entries.slice();
  } catch (error) {
    if (usageReadCache?.path === path) usageReadCache = null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function usageCacheNeedsFullRead(path: string): boolean {
  const cache = usageReadCache;
  if (!cache || cache.path !== path) return true;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    if (!sameUsageFile(cache, stat) || size < cache.size) return true;
    if (size === cache.size) {
      return Number(stat.mtimeMs) !== cache.mtimeMs || Number(stat.ctimeMs) !== cache.ctimeMs;
    }
    if (!cache.endedWithNewline) return true;
    const signatureStart = Math.max(0, cache.size - cache.tailSignature.length);
    const signature = readExactly(fd, cache.tailSignature.length, signatureStart);
    return signature === null || !signature.equals(cache.tailSignature);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Management API reader: full rebuilds yield between parse batches, while the steady
 * append-only path stays synchronous and only processes the small new tail.
 */
export async function readUsageEntriesForManagement(): Promise<PersistedUsageEntry[]> {
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  if (!usageCacheNeedsFullRead(path)) return readUsageEntries();
  if (managementUsageReadInflight?.path === path) {
    return (await managementUsageReadInflight.promise).slice();
  }
  const promise = readUsageEntriesFullCooperatively(path);
  managementUsageReadInflight = { path, promise };
  try {
    return await promise;
  } finally {
    if (managementUsageReadInflight?.promise === promise) managementUsageReadInflight = null;
  }
}

export function readUsageEntries(): PersistedUsageEntry[] {
  const path = usageLogPath();
  if (!existsSync(path)) {
    if (usageReadCache?.path === path) usageReadCache = null;
    return [];
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    const mtimeMs = Number(stat.mtimeMs);
    const ctimeMs = Number(stat.ctimeMs);
    const cache = usageReadCache;
    if (!cache || cache.path !== path || !sameUsageFile(cache, stat) || size < cache.size) {
      return readUsageEntriesFull(path, fd, stat);
    }

    if (size === cache.size) {
      if (mtimeMs !== cache.mtimeMs || ctimeMs !== cache.ctimeMs) {
        return readUsageEntriesFull(path, fd, stat);
      }
      return cache.entries.slice();
    }

    // A writer may truncate and rewrite the same inode between polls. Verify the old
    // suffix before trusting a larger size as an append; this costs at most 64 bytes.
    const signatureStart = Math.max(0, cache.size - cache.tailSignature.length);
    const currentSignature = readExactly(fd, cache.tailSignature.length, signatureStart);
    if (
      !cache.endedWithNewline
      || currentSignature === null
      || !currentSignature.equals(cache.tailSignature)
    ) {
      return readUsageEntriesFull(path, fd, stat);
    }

    const appended = readExactly(fd, size - cache.size, cache.size);
    if (appended === null) return readUsageEntriesFull(path, fd, stat);
    const appendedEntries = parseUsageText(appended.toString("utf-8"));
    usageReadCacheStats.tailReads += 1;
    const entries = [...cache.entries, ...appendedEntries];
    const combinedTail = Buffer.concat([cache.tailSignature, appended]);
    usageReadCache = {
      path,
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      birthtimeMs: Number(stat.birthtimeMs),
      size,
      mtimeMs,
      ctimeMs,
      endedWithNewline: appended.length === 0 || appended[appended.length - 1] === 0x0a,
      tailSignature: usageTailSignature(combinedTail),
      entries,
    };
    return entries.slice();
  } catch (error) {
    usageReadCache = null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseUsageLines(lines: string[]): PersistedUsageEntry[] {
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedUsageEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
        entries.push(normalizeUsageEntry(parsed));
      }
    } catch {
      /* skip partial / hand-edited lines */
    }
  }
  return entries;
}

/**
 * Read only the newest `limit` usage.jsonl rows without loading the whole append-only
 * file into memory. Used by request-log hydration on `ocx start`.
 */
export function readRecentUsageEntries(limit: number): PersistedUsageEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    // ~4 KiB/row budget with a floor; expand once if the window yields too few lines.
    let windowBytes = Math.min(size, Math.max(64 * 1024, Math.ceil(limit) * 4 * 1024));
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = Math.max(0, size - windowBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf-8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl < 0) {
          if (start === 0) break;
          windowBytes = Math.min(size, windowBytes * 4);
          continue;
        }
        text = text.slice(nl + 1);
      }
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      // Parse ALL lines first, then take the last N valid entries. This way corrupt
      // or partial lines are filtered out during parsing and we always return the
      // most recent N valid rows (not N physical lines minus corrupt ones).
      const entries = parseUsageLines(lines);
      if (entries.length >= limit || start === 0 || windowBytes >= size) return entries.slice(-limit);
      windowBytes = Math.min(size, windowBytes * 4);
    }
    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
