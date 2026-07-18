import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";

interface TargetCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

/** Map<`${comboId}\0${provider/model}`, TargetCooldown> */
const targetCooldowns = new Map<string, TargetCooldown>();

function cooldownMapKey(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
): string {
  return `${comboId}\0${targetKey(target)}`;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  return delay > 0 ? Math.min(delay, MAX_COOLDOWN_MS) : undefined;
}

export function isComboTargetInCooldown(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.delete(key);
    return false;
  }
  return true;
}

export function coolComboTarget(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  options?: { retryAfter?: string | null; now?: number; cooldownMs?: number },
): void {
  const now = options?.now ?? Date.now();
  const cooldownMs = options?.cooldownMs
    ?? parseRetryAfterMs(options?.retryAfter, now)
    ?? DEFAULT_COOLDOWN_MS;
  targetCooldowns.set(cooldownMapKey(comboId, target), {
    cooldownUntil: now + Math.min(Math.max(cooldownMs, 1), MAX_COOLDOWN_MS),
  });
}

export function clearComboTargetCooldowns(comboId?: string): void {
  if (comboId === undefined) {
    targetCooldowns.clear();
    return;
  }
  const prefix = `${comboId}\0`;
  for (const key of targetCooldowns.keys()) {
    if (key.startsWith(prefix)) targetCooldowns.delete(key);
  }
}
