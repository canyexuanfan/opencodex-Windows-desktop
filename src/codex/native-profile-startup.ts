import { NativeProfileManager } from "./native-profile-manager";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import {
  probeNativeProfileRecoveryState,
  type NativeProfileRecoveryState,
} from "./native-profile-store";

export type NativeMainStartupGateSnapshot =
  | { status: "ready"; homeId: string | null }
  | { status: "blocked"; homeId: string; reason: "recovery-pending" | "manual-recovery" };

export interface NativeMainStartupGateDeps {
  manager?: NativeProfileManager;
  /** Test-only barrier used to prove admission stays closed while startup recovery is pending. */
  beforeRecovery?: () => void | Promise<void>;
  probeRecoveryState?: typeof probeNativeProfileRecoveryState;
}

let epoch = 0;
let snapshot: NativeMainStartupGateSnapshot = { status: "ready", homeId: null };
let settled: Promise<NativeMainStartupGateSnapshot> = Promise.resolve(snapshot);

function ready(homeId: string | null): NativeMainStartupGateSnapshot {
  return { status: "ready", homeId };
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
  const probe = deps.probeRecoveryState ?? probeNativeProfileRecoveryState;
  let recoveryState: NativeProfileRecoveryState;
  try {
    recoveryState = probe(manager.context);
  } catch {
    snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    settled = Promise.resolve(snapshot);
    return settled;
  }
  if (recoveryState === "none") {
    snapshot = ready(homeId);
    settled = Promise.resolve(snapshot);
    return settled;
  }

  if (recoveryState !== "journal") {
    snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
    settled = Promise.resolve(snapshot);
    return settled;
  }

  snapshot = { status: "blocked", homeId, reason: "recovery-pending" };
  settled = (async () => {
    try {
      await deps.beforeRecovery?.();
      await manager.recover(false);
      if (epoch === currentEpoch && probe(manager.context) === "none") {
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        snapshot = ready(homeId);
      } else if (epoch === currentEpoch) {
        snapshot = { status: "blocked", homeId, reason: "manual-recovery" };
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

/**
 * Close the process-wide native-main admission gate after a live transaction
 * leaves recovery state behind. A known different home owns a different
 * native credential file, so it must not be fenced by this transition.
 */
export function blockNativeMainRecovery(
  homeId: string,
  recoveryState?: Exclude<NativeProfileRecoveryState, "none">,
): boolean {
  if (snapshot.homeId !== null && snapshot.homeId !== homeId) return false;
  epoch += 1;
  snapshot = {
    status: "blocked",
    homeId,
    reason: recoveryState === "journal" ? "recovery-pending" : "manual-recovery",
  };
  settled = Promise.resolve(snapshot);
  return true;
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
