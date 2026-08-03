import { NativeProfileManager } from "./native-profile-manager";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import {
  probeNativeProfileRecoveryState,
  type NativeProfileRecoveryState,
} from "./native-profile-store";
import {
  retainNativeMainOwner,
  withNativeMainOwnerOperation,
  type NativeMainOwnerOptions,
  type NativeMainOwnerReference,
  type NativeMainOwnerSnapshot,
} from "./native-main-owner";
import { withNativeMainExclusiveClaim } from "./native-main-claim";

export type NativeMainStartupGateSnapshot =
  | { status: "ready"; homeId: string | null }
  | {
      status: "blocked";
      homeId: string;
      reason: "recovery-pending" | "manual-recovery" | "owner-conflict" | "owner-unavailable";
    };

export interface NativeMainStartupGateDeps {
  manager?: NativeProfileManager;
  /** Test-only barrier used to prove admission stays closed while startup recovery is pending. */
  beforeRecovery?: () => void | Promise<void>;
  probeRecoveryState?: typeof probeNativeProfileRecoveryState;
  owner?: NativeMainOwnerOptions;
}

export interface NativeMainStartupLifecycle {
  readonly homeId: string | null;
  readonly settled: Promise<NativeMainStartupGateSnapshot>;
  release(): Promise<void>;
}

let epoch = 0;
let snapshot: NativeMainStartupGateSnapshot = { status: "ready", homeId: null };
let settled: Promise<NativeMainStartupGateSnapshot> = Promise.resolve(snapshot);
interface StartupEntry {
  homeId: string;
  refs: number;
  epoch: number;
  owner: NativeMainOwnerReference;
  unsubscribe: () => void;
  recoveryStarted: boolean;
  settled: Promise<NativeMainStartupGateSnapshot>;
  resolveAcquisition?: (value: NativeMainStartupGateSnapshot) => void;
  deps: NativeMainStartupGateDeps;
  manager: NativeProfileManager;
}
const startupEntries = new Map<string, StartupEntry>();
const serverLifecycles = new WeakMap<object, NativeMainStartupLifecycle>();

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

function ownerBlockedReason(owner: NativeMainOwnerSnapshot): "owner-conflict" | "owner-unavailable" {
  return owner.status === "unavailable" ? "owner-unavailable" : "owner-conflict";
}

function convergeOwnedStartup(entry: StartupEntry): void {
  if (entry.recoveryStarted) return;
  entry.recoveryStarted = true;
  const currentEpoch = entry.epoch;
  snapshot = { status: "blocked", homeId: entry.homeId, reason: "recovery-pending" };
  const acquisitionWaiter = entry.resolveAcquisition;
  entry.resolveAcquisition = undefined;
  entry.settled = settled = (async () => {
    const probe = entry.deps.probeRecoveryState ?? probeNativeProfileRecoveryState;
    try {
      let recoveryState = probe(entry.manager.context);
      if (recoveryState === "journal") {
        await entry.deps.beforeRecovery?.();
        await withNativeMainOwnerOperation(entry.manager.context, () => withNativeMainExclusiveClaim(
          entry.manager.context,
          () => entry.manager.recover(false),
          { waitMs: 10_000 },
        ));
        recoveryState = probe(entry.manager.context);
      }
      if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch && recoveryState === "none") {
        clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
        snapshot = ready(entry.homeId);
      } else if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch) {
        snapshot = { status: "blocked", homeId: entry.homeId, reason: "manual-recovery" };
      }
    } catch {
      if (startupEntries.get(entry.homeId) === entry && entry.epoch === currentEpoch) {
        snapshot = { status: "blocked", homeId: entry.homeId, reason: "manual-recovery" };
      }
    }
    return snapshot;
  })();
  if (acquisitionWaiter) void entry.settled.then(acquisitionWaiter);
}

function observeOwner(entry: StartupEntry, owner: NativeMainOwnerSnapshot): void {
  if (startupEntries.get(entry.homeId) !== entry) return;
  if (owner.status === "acquiring") {
    snapshot = { status: "blocked", homeId: entry.homeId, reason: "recovery-pending" };
    return;
  }
  if (owner.status === "held") {
    convergeOwnedStartup(entry);
    return;
  }
  if (owner.status === "closing" || owner.status === "released") return;
  snapshot = { status: "blocked", homeId: entry.homeId, reason: ownerBlockedReason(owner) };
  entry.settled = settled = Promise.resolve(snapshot);
  entry.resolveAcquisition?.(snapshot);
  entry.resolveAcquisition = undefined;
}

/**
 * Retain process ownership for one live server. The first reference acquires the
 * canonical-home SQLite lease and owns recovery; later same-process references share it.
 */
export function startNativeMainStartupLifecycle(
  deps: NativeMainStartupGateDeps = {},
): NativeMainStartupLifecycle {
  let manager: NativeProfileManager;
  try {
    manager = deps.manager ?? new NativeProfileManager();
  } catch {
    snapshot = ready(null);
    settled = Promise.resolve(snapshot);
    return { homeId: null, settled, release: async () => {} };
  }
  const homeId = manager.context.homeId;
  let entry = startupEntries.get(homeId);
  if (!entry) {
    const owner = retainNativeMainOwner(manager.context, deps.owner);
    snapshot = { status: "blocked", homeId, reason: "recovery-pending" };
    let resolveAcquisition!: (value: NativeMainStartupGateSnapshot) => void;
    const acquisition = new Promise<NativeMainStartupGateSnapshot>(resolve => { resolveAcquisition = resolve; });
    settled = acquisition;
    entry = {
      homeId,
      refs: 0,
      epoch: ++epoch,
      owner,
      unsubscribe: () => {},
      recoveryStarted: false,
      settled: acquisition,
      resolveAcquisition,
      deps,
      manager,
    };
    startupEntries.set(homeId, entry);
    entry.unsubscribe = owner.subscribe(ownerState => observeOwner(entry!, ownerState));
  }
  entry.refs += 1;
  let released = false;
  return {
    homeId,
    get settled() { return entry!.settled; },
    async release() {
      if (released) return;
      released = true;
      entry!.refs = Math.max(0, entry!.refs - 1);
      if (entry!.refs !== 0) return;
      entry!.epoch += 1;
      entry!.unsubscribe();
      startupEntries.delete(homeId);
      entry!.resolveAcquisition?.(snapshot);
      entry!.resolveAcquisition = undefined;
      await entry!.owner.release();
    },
  };
}

export function bindNativeMainStartupLifecycle(server: object, lifecycle: NativeMainStartupLifecycle): void {
  serverLifecycles.set(server, lifecycle);
}

export async function releaseNativeMainStartupLifecycle(server: object): Promise<void> {
  const lifecycle = serverLifecycles.get(server);
  if (!lifecycle) return;
  serverLifecycles.delete(server);
  await lifecycle.release();
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
