/**
 * Long-running schedule tick for daily/weekly storage cleanup policies.
 * Unref'd interval — never keeps the process alive alone (safe for tests).
 */
import { maybeRunDueStorageCleanupPolicy } from "./policy";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

let timer: ReturnType<typeof setInterval> | null = null;

export function startStorageCleanupScheduler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    maybeRunDueStorageCleanupPolicy("schedule");
  }, intervalMs);
  timer.unref?.();
}

export function stopStorageCleanupScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
