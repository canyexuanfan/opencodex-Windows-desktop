/**
 * Evidence-based route health (RI-06).
 *
 * Health evidence combines:
 * - live in-memory routing state: Codex account cooldown / soft-avoid
 *   (authoritative hard state);
 * - historical evidence from the request-history index: success rate,
 *   consecutive failures, incomplete-stream rate, recent latency, sample
 *   count, recency-decayed weights.
 *
 * Failure classification is strict: client cancellations, invalid requests
 * (4xx except quota 429) and synthetic policy refusals never damage target
 * health. Transport-neutral failures are excluded by the classification the
 * routing layer already records (host/account split per #914 work).
 *
 * All formulas are deterministic with documented constants; no ML.
 */

import type { OcxConfig } from "../types";
import { openRequestHistoryIndexSync, requestHistoryDb } from "./history/indexer";
import {
  getCodexAccountCooldownUntil,
  getCodexAccountSoftAvoidUntil,
  isCodexAccountInCooldown,
} from "../codex/routing";
import type { RouteHealthEvidence } from "./trace";

export const HEALTH_SCORE_CONSTANTS = {
  /** Recent-success weight in the composite. */
  SUCCESS_WEIGHT: 0.50,
  /** Incomplete-stream (negative) weight. */
  INCOMPLETE_WEIGHT: 0.15,
  /** Recent-latency weight. */
  LATENCY_WEIGHT: 0.20,
  /** Consecutive-failure recovery weight. */
  RECOVERY_WEIGHT: 0.15,
  /** p50 latency at or above this (ms) scores zero on the latency axis. */
  LATENCY_TARGET_MS: 60_000,
  /** Samples needed for full confidence; fewer samples scale the score down. */
  MIN_CONFIDENCE_SAMPLES: 20,
  /** Soft-avoid multiplies the composite. */
  SOFT_AVOID_MULTIPLIER: 0.5,
  /** Recency decay: a sample loses half its weight every RECENCY_HALF_LIFE_DAYS. */
  RECENCY_HALF_LIFE_DAYS: 7,
} as const;

export const HEALTH_WINDOW_MS = 14 * 86_400_000;
export const HEALTH_MAX_SAMPLES = 100;

export interface HealthEvidenceInput {
  provider: string;
  model: string;
  accountRef?: string;
  /** Live codex account id for cooldown/soft-avoid state (provider "openai"). */
  codexAccountId?: string;
  now?: number;
}

interface HealthSample {
  status: number;
  closeReason: string | null;
  terminalStatus: string | null;
  durationMs: number;
  timestamp: number;
}

function classifySample(sample: HealthSample): "success" | "failure" | "neutral" {
  if (sample.closeReason === "client_cancel" || sample.status === 499) return "neutral";
  // Invalid requests and policy refusals must not poison target health.
  if (sample.status >= 400 && sample.status < 500 && sample.status !== 429) return "neutral";
  if (sample.terminalStatus === "incomplete") return "failure";
  if (sample.terminalStatus && sample.terminalStatus !== "completed") return "failure";
  if (sample.status >= 400) return "failure";
  return "success";
}

function decayWeight(timestamp: number, now: number): number {
  const ageDays = Math.max(0, now - timestamp) / 86_400_000;
  return Math.pow(0.5, ageDays / HEALTH_SCORE_CONSTANTS.RECENCY_HALF_LIFE_DAYS);
}

function median(sorted: number[]): number | undefined {
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Historical health evidence from the derived index (synchronous: called at
 * routing time). Never throws; an unopened/unreadable index yields unknown.
 */
export function healthEvidenceForCandidate(input: HealthEvidenceInput): RouteHealthEvidence {
  const now = input.now ?? Date.now();
  const evidence: RouteHealthEvidence = {};

  // Live authoritative state: hard cooldown and soft-avoid for Codex pool
  // accounts. Cooldown stays authoritative over any historical score.
  if (input.codexAccountId && input.provider === "openai") {
    if (isCodexAccountInCooldown(input.codexAccountId, now)) {
      const until = getCodexAccountCooldownUntil(input.codexAccountId, now);
      if (until !== null) evidence.cooldownUntilMs = until;
    }
    const softAvoidUntil = getCodexAccountSoftAvoidUntil(input.codexAccountId, now);
    if (softAvoidUntil !== null && softAvoidUntil > now) evidence.softAvoidUntilMs = softAvoidUntil;
  }

  try {
    openRequestHistoryIndexSync();
    const handle = requestHistoryDb();
    const where: string[] = ["provider = ?", "model = ?", "timestamp >= ?"];
    const values: Array<string | number> = [input.provider, input.model, now - HEALTH_WINDOW_MS];
    if (input.accountRef) {
      where.push("api_key_id = ?");
      values.push(input.accountRef);
    }
    const rows = handle.query(
      `SELECT status, close_reason AS closeReason, terminal_status AS terminalStatus,
              duration_ms AS durationMs, timestamp
       FROM requests WHERE ${where.join(" AND ")}
       ORDER BY timestamp DESC LIMIT ?`,
    ).all(...values, HEALTH_MAX_SAMPLES) as HealthSample[];

    let successes = 0;
    let failures = 0;
    let incompleteStreams = 0;
    let weightedSuccess = 0;
    let weightedTotal = 0;
    const latencies: number[] = [];
    let consecutiveFailures = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const kind = classifySample(row);
      const weight = decayWeight(row.timestamp, now);
      if (kind === "neutral") continue;
      if (kind === "success") {
        successes += 1;
        weightedSuccess += weight;
        weightedTotal += weight;
      } else {
        failures += 1;
        weightedTotal += weight;
      }
      if (row.terminalStatus === "incomplete") incompleteStreams += 1;
      latencies.push(row.durationMs);
    }
    // Consecutive failures: walk newest -> oldest until a success.
    let consecutive = 0;
    for (const row of rows) {
      const kind = classifySample(row);
      if (kind === "neutral") continue;
      if (kind === "failure") consecutive += 1;
      else break;
    }
    consecutiveFailures = consecutive;

    const sampleCount = successes + failures;
    if (sampleCount > 0) {
      evidence.sampleCount = sampleCount;
      evidence.successRate = weightedTotal > 0 ? weightedSuccess / weightedTotal : 0;
      if (consecutiveFailures > 0) evidence.failures = consecutiveFailures;
      if (incompleteStreams > 0) evidence.incompleteStreamRate = incompleteStreams / sampleCount;
      latencies.sort((a, b) => a - b);
      const p50 = median(latencies);
      if (p50 !== undefined) evidence.recentLatencyMs = p50;
      evidence.recencyWeight = decayWeight(rows[0]!.timestamp, now);
    }
  } catch {
    /* index unreadable: evidence stays unknown */
  }

  return evidence;
}

/**
 * Deterministic health score in [0,1]. Returns null when evidence is unknown
 * (no samples) so callers can apply the profile's unknownEvidence policy.
 * A live hard cooldown scores 0 (authoritative).
 */
export function healthScore(evidence: RouteHealthEvidence | undefined, now = Date.now()): number | null {
  if (!evidence) return null;
  if (evidence.cooldownUntilMs !== undefined && evidence.cooldownUntilMs > now) return 0;
  if (!evidence.sampleCount || evidence.sampleCount < 1) return null;
  const successRate = evidence.successRate ?? 0;
  const incompleteRate = evidence.incompleteStreamRate ?? 0;
  const p50 = evidence.recentLatencyMs;
  const latencyScore = p50 === undefined
    ? 0.5
    : Math.max(0, Math.min(1, 1 - p50 / HEALTH_SCORE_CONSTANTS.LATENCY_TARGET_MS));
  const consecutive = evidence.failures ?? 0;
  const recoveryScore = 1 - Math.min(1, consecutive / 5);
  const composite = HEALTH_SCORE_CONSTANTS.SUCCESS_WEIGHT * successRate
    + HEALTH_SCORE_CONSTANTS.INCOMPLETE_WEIGHT * (1 - incompleteRate)
    + HEALTH_SCORE_CONSTANTS.LATENCY_WEIGHT * latencyScore
    + HEALTH_SCORE_CONSTANTS.RECOVERY_WEIGHT * recoveryScore;
  const confidence = Math.min(1, evidence.sampleCount / HEALTH_SCORE_CONSTANTS.MIN_CONFIDENCE_SAMPLES);
  const softAvoid = evidence.softAvoidUntilMs !== undefined && evidence.softAvoidUntilMs > now
    ? HEALTH_SCORE_CONSTANTS.SOFT_AVOID_MULTIPLIER
    : 1;
  return composite * confidence * softAvoid;
}
