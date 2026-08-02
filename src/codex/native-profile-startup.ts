import { statSync } from "node:fs";

import { NativeProfileManager } from "./native-profile-manager";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";

export type NativeMainStartupGateSnapshot =
  | { status: "ready"; homeId: string | null }
  | { status: "blocked"; homeId: string; reason: "recovery-pending" | "manual-recovery" };

export interface NativeMainStartupGateDeps {
  manager?: NativeProfileManager;
  /** Test-only barrier used to prove admission stays closed while startup recovery is pending. */
  beforeRecovery?: () => void | Promise<void>;
  inspectJournal?: typeof inspectNativeMainRecoveryJournal;
}

let epoch = 0;
let snapshot: NativeMainStartupGateSnapshot = { status: "ready", homeId: null };
let settled: Promise<NativeMainStartupGateSnapshot> = Promise.resolve(snapshot);

function ready(homeId: string | null): NativeMainStartupGateSnapshot {
  return { status: "ready", homeId };
}

export function inspectNativeMainRecoveryJournal(
  path: string,
  stat: (path: string) => unknown = statSync,
): "present" | "absent" {
  try {
    stat(path);
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
    throw error;
  }
}

/**
 * Arm the native-main gate synchronously, then converge the encrypted journal in the background.
 * No credential bytes are read here: journal/auth inspection remains inside NativeProfileManager.
 */
export function initializeNativeMainStartupGate(
  deps: NativeMainStartupGateDeps = {},
): Promise<NativeMainStartupGateSnapshot> {
  const currentEpoch = ++epoch;
  let manager: NativeProfileManager;
  try {
    manager = deps.manager ?? new NativeProfileManager();
  } catch {
    // A missing/unresolvable Codex home cannot provide a usable native-main token either.
    // Do not turn an unused opt-in feature into a process-wide startup outage.
    snapshot = ready(null);
    settled = Promise.resolve(snapshot);
    return settled;
  }

  const homeId = manager.context.homeId;
  let journal: "present" | "absent";
  try {
    journal = (deps.inspectJournal ?? inspectNativeMainRecoveryJournal)(manager.context.journalPath);
  } catch {
    snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    settled = Promise.resolve(snapshot);
    return settled;
  }
  if (journal === "absent") {
    snapshot = ready(homeId);
    settled = Promise.resolve(snapshot);
    return settled;
  }

  snapshot = { status: "blocked", homeId, reason: "recovery-pending" };
  settled = (async () => {
    try {
      await deps.beforeRecovery?.();
      await manager.recover(false);
      if (epoch === currentEpoch) {
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        snapshot = ready(homeId);
      }
    } catch {
      if (epoch === currentEpoch) snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    }
    return snapshot;
  })();
  return settled;
}

export function isNativeMainTrafficBlocked(): boolean {
  return snapshot.status === "blocked";
}

export function completeNativeMainRecovery(homeId: string): boolean {
  if (snapshot.status !== "blocked" || snapshot.homeId !== homeId) return false;
  epoch += 1;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  snapshot = ready(homeId);
  settled = Promise.resolve(snapshot);
  return true;
}

export function nativeMainStartupGateSnapshot(): NativeMainStartupGateSnapshot {
  return { ...snapshot };
}

export function waitForNativeMainStartupGate(): Promise<NativeMainStartupGateSnapshot> {
  return settled;
}
