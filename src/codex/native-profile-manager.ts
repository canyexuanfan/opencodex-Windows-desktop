import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteFileAsync } from "../config";
import { hardenSecretPathAsync } from "../lib/windows-secret-acl";
import { applyConfirmedMainCodexAccountTransition } from "./account-lifecycle";
import { decideNativeProfileRecovery } from "./native-profile-recovery";
import { probeNativeCodexProcesses, type NativeCodexProcessProbe } from "./native-profile-processes";
import {
  assertUniqueNativeProfileLabel,
  decryptNativeEnvelope,
  encryptNativeEnvelope,
  inspectNativeProfileJournal,
  MAX_NATIVE_PROFILES,
  nativeIdentityHash,
  nativeIdentityHint,
  OsNativeProfileKeyProvider,
  publicNativeProfile,
  readNativeEnvelope,
  readNativeEnvelopeResult,
  readNativeProfileVault,
  probeNativeProfileRecoveryState,
  requireFileCredentialStore,
  resolveNativeCredentialStoreMode,
  resolveNativeProfileContext,
  serializeNativeProfileJournal,
  serializeNativeProfileMetadata,
  validateNativeProfileLabel,
  type NativeEnvelopeSnapshot,
  type NativeProfileContext,
} from "./native-profile-store";
import {
  NativeProfileError,
  type NativeMainProfileRecordV1,
  type NativeMainProfileVaultV1,
  type NativeProfileKey,
  type NativeProfileKeyProvider,
  type NativeProfilePublic,
  type NativeProfileSwitchJournalV1,
} from "./native-profile-types";

const LOCK_WAIT_MS = 5_000;
const STAGE_MAX_AGE_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AtomicWriter = (path: string, content: string) => Promise<void>;
type TransitionApplier = (fromAccountId: string, toAccountId: string) => void;
type EnvelopeReader = (path: string) => NativeEnvelopeSnapshot;
type VaultReader = () => NativeMainProfileVaultV1 | null;
type EnvelopeResultReader = (path: string) => ReturnType<typeof readNativeEnvelopeResult>;
export type NativeProfileSwitchBoundary =
  | "journal-prepared"
  | "auth-replaced"
  | "vault-committed"
  | "runtime-transition-published"
  | "journal-deleted";

export interface NativeProfileManagerOptions {
  codexHome?: string;
  configDir?: string;
  keyProvider?: NativeProfileKeyProvider;
  atomicWrite?: AtomicWriter;
  hardenPath?: (path: string) => Promise<void>;
  processProbe?: () => Promise<NativeCodexProcessProbe>;
  applyTransition?: TransitionApplier;
  now?: () => number;
  randomUUID?: () => string;
  sleep?: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  onLockAcquired?: () => void | Promise<void>;
  removeStageTree?: (path: string) => void;
  /** Test-only crash seam; production never supplies this callback. */
  onSwitchBoundary?: (boundary: NativeProfileSwitchBoundary) => void | Promise<void>;
  /** Test-only reader seams; production uses the native profile store directly. */
  readEnvelope?: EnvelopeReader;
  readVault?: VaultReader;
  readEnvelopeResult?: EnvelopeResultReader;
}

export interface NativeProfileListResult {
  effectiveCodexHome: string;
  activeProfileId: string | null;
  profiles: NativeProfilePublic[];
}

async function hardenNativeProfilePath(path: string): Promise<void> {
  const mode = statSync(path).isDirectory() ? 0o700 : 0o600;
  try { chmodSync(path, mode); } catch { /* Windows ACL below is authoritative there. */ }
  if (process.platform === "win32") {
    await hardenSecretPathAsync(path, { required: true, timeoutMemoKey: path });
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

export class NativeProfileManager {
  readonly context: NativeProfileContext;
  private readonly keyProvider: NativeProfileKeyProvider;
  private readonly atomicWrite: AtomicWriter;
  private readonly hardenPath: (path: string) => Promise<void>;
  private readonly processProbe: () => Promise<NativeCodexProcessProbe>;
  private readonly applyTransition: TransitionApplier;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lockWaitMs: number;
  private readonly onLockAcquired: () => void | Promise<void>;
  private readonly removeStageTree: (path: string) => void;
  private readonly onSwitchBoundary: (boundary: NativeProfileSwitchBoundary) => void | Promise<void>;
  private readonly readEnvelope: EnvelopeReader;
  private readonly readVault: VaultReader;
  private readonly readEnvelopeResult: EnvelopeResultReader;

  constructor(options: NativeProfileManagerOptions = {}) {
    this.context = resolveNativeProfileContext(options);
    this.keyProvider = options.keyProvider ?? new OsNativeProfileKeyProvider();
    this.atomicWrite = options.atomicWrite ?? atomicWriteFileAsync;
    this.hardenPath = options.hardenPath ?? hardenNativeProfilePath;
    this.processProbe = options.processProbe ?? probeNativeCodexProcesses;
    this.applyTransition = options.applyTransition ?? ((from, to) => { applyConfirmedMainCodexAccountTransition(from, to); });
    this.now = options.now ?? Date.now;
    this.uuid = options.randomUUID ?? randomUUID;
    this.sleep = options.sleep ?? (ms => Bun.sleep(ms));
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.onLockAcquired = options.onLockAcquired ?? (() => {});
    this.removeStageTree = options.removeStageTree ?? (path => rmSync(path, { recursive: true, force: false }));
    this.onSwitchBoundary = options.onSwitchBoundary ?? (() => {});
    this.readEnvelope = options.readEnvelope ?? readNativeEnvelope;
    this.readVault = options.readVault ?? (() => readNativeProfileVault(this.context));
    this.readEnvelopeResult = options.readEnvelopeResult ?? readNativeEnvelopeResult;
  }

  private async ensureRoot(): Promise<void> {
    if (!existsSync(this.context.rootDir)) mkdirSync(this.context.rootDir, { recursive: true, mode: 0o700 });
    await this.hardenPath(this.context.rootDir);
  }

  private async ensureLockDatabase(): Promise<void> {
    let database: Database | undefined;
    try {
      database = new Database(this.context.lockPath, { create: true });
    } catch {
      throw new NativeProfileError("PROFILE_LOCK_UNAVAILABLE", "The native-profile lock is unavailable.", 503, true);
    } finally {
      try { database?.close(); } catch { /* acquisition already failed */ }
    }
    try {
      try { chmodSync(this.context.lockPath, 0o600); } catch { /* Windows ACL below is authoritative there. */ }
      await this.hardenPath(this.context.lockPath);
    } catch {
      throw new NativeProfileError("PROFILE_LOCK_UNAVAILABLE", "The native-profile lock could not be permission-hardened.", 503, true);
    }
  }

  private isLockBusy(error: unknown): boolean {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /database (?:is|table is) locked/i.test(message);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    await this.ensureLockDatabase();
    const deadline = this.now() + this.lockWaitMs;
    let database: Database | undefined;
    while (!database) {
      let candidate: Database | undefined;
      try {
        candidate = new Database(this.context.lockPath, { create: true });
        candidate.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
        database = candidate;
      } catch (error) {
        try { candidate?.close(); } catch { /* acquisition already failed */ }
        if (!this.isLockBusy(error)) {
          throw new NativeProfileError("PROFILE_LOCK_UNAVAILABLE", "The native-profile lock is unavailable.", 503, true);
        }
        if (this.now() >= deadline) {
          throw new NativeProfileError("NATIVE_PROFILE_BUSY", "Another native-profile operation is still running.", 503, true);
        }
        await this.sleep(50);
      }
    }
    try {
      await this.onLockAcquired();
      return await operation();
    } finally {
      try { database.exec("ROLLBACK"); } catch { /* close still releases the OS-backed lock */ }
      try { database.close(); } catch { /* transaction is already ending */ }
    }
  }

  private async assertNativeCodexStopped(confirmedStopped: boolean): Promise<void> {
    const processState = await this.processProbe();
    if (processState.status === "busy") {
      throw new NativeProfileError("CODEX_BUSY", `Close the ${processState.count} detected native Codex process(es) before switching.`, 409);
    }
    if (processState.status === "unknown" && !confirmedStopped) {
      throw new NativeProfileError("CODEX_PROCESS_CHECK_UNAVAILABLE", "Codex process state could not be confirmed; close Codex and retry with explicit confirmation.", 409);
    }
  }

  private async keyForVault(vault: NativeMainProfileVaultV1 | null): Promise<NativeProfileKey> {
    const existing = await this.keyProvider.get(this.context.homeId);
    if (existing) return existing;
    if (vault) {
      throw new NativeProfileError("KEYRING_KEY_MISSING", "The OS credential-store key for this vault is missing.", 409);
    }
    return this.keyProvider.create(this.context.homeId);
  }

  private async writeVault(vault: NativeMainProfileVaultV1): Promise<void> {
    await this.atomicWrite(this.context.vaultPath, serializeNativeProfileMetadata(vault));
  }

  private async writeJournal(journal: NativeProfileSwitchJournalV1): Promise<void> {
    await this.atomicWrite(this.context.journalPath, serializeNativeProfileJournal(journal));
  }

  private removeJournal(): void {
    try { unlinkSync(this.context.journalPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }

  private removeRecoveryBlock(): void {
    try { unlinkSync(this.context.recoveryBlockPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }

  private async currentOwnershipConfirmed(): Promise<boolean> {
    let key: NativeProfileKey | null = null;
    let current: NativeEnvelopeSnapshot | null = null;
    try {
      const vault = this.readVault();
      if (!vault) return false;
      key = await this.keyForVault(vault);
      current = this.readEnvelope(this.context.authPath);
      this.assertCurrentIdentity(vault, current, key);
      return true;
    } catch {
      return false;
    } finally {
      current?.raw.fill(0);
      key?.key.fill(0);
    }
  }

  private async clearRecoveryBlockLocked(): Promise<Record<string, unknown>> {
    if (!(await this.currentOwnershipConfirmed())) {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The quarantined recovery state remains blocked until auth.json matches the active encrypted profile.",
        409,
      );
    }
    this.removeRecoveryBlock();
    return {
      ok: true,
      recovered: true,
      action: "confirm-current-owner",
      externallyRefreshed: false,
      effectiveCodexHome: this.context.codexHome,
      restartRequired: false,
    };
  }

  private async quarantineInvalidJournalLocked(): Promise<Record<string, unknown>> {
    const quarantineFile = this.context.homeId + ".journal.quarantine-" + this.uuid() + ".json";
    const quarantinePath = join(this.context.rootDir, quarantineFile);
    await this.atomicWrite(this.context.recoveryBlockPath, serializeNativeProfileMetadata({
      version: 1,
      homeId: this.context.homeId,
      reason: "malformed-journal",
      quarantineFile,
      createdAt: new Date(this.now()).toISOString(),
    }));
    try {
      renameSync(this.context.journalPath, quarantinePath);
    } catch {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The invalid recovery journal could not be quarantined; the fail-closed recovery marker remains active.",
        409,
      );
    }
    if (!(await this.currentOwnershipConfirmed())) {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The invalid recovery journal was quarantined as " + quarantineFile + ", but current credential ownership is not confirmed.",
        409,
      );
    }
    this.removeRecoveryBlock();
    return {
      ok: true,
      recovered: true,
      action: "quarantine-invalid-journal",
      quarantineFile,
      externallyRefreshed: false,
      effectiveCodexHome: this.context.codexHome,
      restartRequired: false,
    };
  }

  private assertNoPendingRecovery(): void {
    if (probeNativeProfileRecoveryState(this.context) === "none") return;
    throw new NativeProfileError(
      "RECOVERY_REQUIRED",
      "A native-profile recovery journal is pending. Run `ocx account main recover` or `ocx account main recover --rollback --yes` before registering or adding profiles.",
      409,
    );
  }

  private requireVault(): NativeMainProfileVaultV1 {
    const vault = this.readVault();
    if (!vault) throw new NativeProfileError("PROFILE_NOT_FOUND", "Register the current native login before adding or switching profiles.", 404);
    return vault;
  }

  private currentProfile(vault: NativeMainProfileVaultV1): NativeMainProfileRecordV1 {
    const profile = vault.profiles.find(item => item.id === vault.activeProfileId && item.state === "active");
    if (!profile) throw new NativeProfileError("VAULT_INVALID", "The native-profile vault has no active owner.", 409);
    return profile;
  }

  private assertCurrentIdentity(vault: NativeMainProfileVaultV1, envelope: NativeEnvelopeSnapshot, key: NativeProfileKey): NativeMainProfileRecordV1 {
    const active = this.currentProfile(vault);
    if (nativeIdentityHash(key.key, envelope.accountId) !== active.identityHash) {
      throw new NativeProfileError(
        "ACTIVE_PROFILE_MISMATCH",
        "The physical native login changed outside OpenCodex; recover or register the expected login before continuing.",
        409,
      );
    }
    return active;
  }

  async register(labelInput: string): Promise<{ effectiveCodexHome: string; profile: NativeProfilePublic }> {
    return this.withLock(async () => {
      this.assertNoPendingRecovery();
      requireFileCredentialStore(this.context);
      const label = validateNativeProfileLabel(labelInput);
      let envelope: NativeEnvelopeSnapshot | null = null;
      let key: NativeProfileKey | null = null;
      try {
        envelope = this.readEnvelope(this.context.authPath);
        let vault = this.readVault();
        key = await this.keyForVault(vault);
        const identityHash = nativeIdentityHash(key.key, envelope.accountId);
        const timestamp = new Date(this.now()).toISOString();
        if (!vault) {
          const id = this.uuid();
          vault = {
            version: 1,
            revision: 1,
            homeId: this.context.homeId,
            activeProfileId: id,
            profiles: [{
              id,
              label,
              identityHash,
              identityHint: nativeIdentityHint(identityHash),
              state: "active",
              payload: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }],
          };
        } else {
          const active = this.assertCurrentIdentity(vault, envelope, key);
          assertUniqueNativeProfileLabel(vault, label, active.id);
          active.label = label;
          active.updatedAt = timestamp;
          vault.revision += 1;
        }
        await this.writeVault(vault);
        return { effectiveCodexHome: this.context.codexHome, profile: publicNativeProfile(this.currentProfile(vault)) };
      } finally {
        envelope?.raw.fill(0);
        key?.key.fill(0);
      }
    });
  }

  async list(): Promise<NativeProfileListResult> {
    const vault = readNativeProfileVault(this.context);
    return {
      effectiveCodexHome: this.context.codexHome,
      activeProfileId: vault?.activeProfileId ?? null,
      profiles: vault?.profiles.map(publicNativeProfile) ?? [],
    };
  }

  async doctor(): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
    let stagingSweep: "ok" | "cleanup-required" | "unreadable" = "ok";
    try {
      this.sweepStaleStages();
    } catch (error) {
      stagingSweep = error instanceof NativeProfileError && error.code === "STAGING_CLEANUP_REQUIRED"
        ? "cleanup-required"
        : "unreadable";
    }
    const mode = (() => {
      try { return resolveNativeCredentialStoreMode(this.context); } catch { return "unknown"; }
    })();
    const auth = this.readEnvelopeResult(this.context.authPath);
    try {
      let vault: NativeMainProfileVaultV1 | null = null;
      let vaultStatus: "ok" | "missing" | "invalid" = "missing";
      try {
        vault = this.readVault();
        vaultStatus = vault ? "ok" : "missing";
      } catch {
        vaultStatus = "invalid";
      }
      let keyStore: "available" | "missing-key" | "unavailable" = "available";
      try {
        const key = await this.keyProvider.get(this.context.homeId);
        if (vaultStatus !== "missing" && !key) keyStore = "missing-key";
        if (key) key.key.fill(0);
      } catch {
        keyStore = "unavailable";
      }
      let stagingCount: number | null = 0;
      try {
        if (existsSync(this.context.stagingRoot)) {
          stagingCount = Array.from(new Bun.Glob("*").scanSync({ cwd: this.context.stagingRoot, onlyFiles: false })).length;
        }
      } catch {
        stagingSweep = "unreadable";
        stagingCount = null;
      }
      return {
        effectiveCodexHome: this.context.codexHome,
        credentialStoreMode: mode,
        supported: mode === "file",
        authStatus: auth.status,
        keyStore,
        vaultStatus,
        profileCount: vaultStatus === "invalid" ? null : vault?.profiles.length ?? 0,
        activeProfileId: vault?.activeProfileId ?? null,
        recoveryPending: probeNativeProfileRecoveryState(this.context) !== "none",
        recoveryState: probeNativeProfileRecoveryState(this.context),
        stagingSweep,
        stagingCount,
      };
    } finally {
      if (auth.status === "ok") auth.envelope.raw.fill(0);
    }
    });
  }

  private stagePath(stageId: string): string {
    if (!UUID_RE.test(stageId)) throw new NativeProfileError("INVALID_REQUEST", "The staging identifier is invalid.", 400);
    return join(this.context.stagingRoot, stageId);
  }

  private verifiedStagePath(stageId: string, requireFresh = true): string {
    const expected = resolve(this.stagePath(stageId));
    try {
      if (lstatSync(expected).isSymbolicLink() || !lstatSync(expected).isDirectory()) throw new Error("stage type");
      const canonicalRoot = resolve(realpathSync.native(this.context.stagingRoot));
      const canonicalExpected = resolve(realpathSync.native(expected));
      const rel = relative(canonicalRoot, canonicalExpected);
      if (!rel || rel.startsWith("..") || rel.includes(sep)) throw new Error("stage root");
      const metadata = JSON.parse(readFileSync(join(canonicalExpected, "stage.json"), "utf8")) as Record<string, unknown>;
      if (metadata.version !== 1 || metadata.stageId !== stageId || metadata.homeId !== this.context.homeId) throw new Error("stage metadata");
      if (typeof metadata.createdAt !== "number") throw new Error("stage age");
      if (requireFresh && this.now() - metadata.createdAt > STAGE_MAX_AGE_MS) throw new Error("stage age");
      return canonicalExpected;
    } catch {
      throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing, expired, or invalid.", 404);
    }
  }

  private deleteStage(path: string): void {
    const authPath = join(path, "auth.json");
    try {
      const authStat = lstatSync(authPath);
      if (authStat.isFile() && !authStat.isSymbolicLink()) truncateSync(authPath, 0);
    } catch { /* removal below is authoritative */ }
    this.removeStageTree(path);
  }

  private deleteStageById(stageId: string): void {
    const expected = resolve(this.stagePath(stageId));
    let stageStat: ReturnType<typeof lstatSync>;
    try { stageStat = lstatSync(expected); } catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) {
      unlinkSync(expected);
      return;
    }
    const canonicalRoot = resolve(realpathSync.native(this.context.stagingRoot));
    const canonicalExpected = resolve(realpathSync.native(expected));
    const rel = relative(canonicalRoot, canonicalExpected);
    if (!rel || rel.startsWith("..") || rel.includes(sep)) {
      throw new NativeProfileError("STAGING_CLEANUP_REQUIRED", "The staging path could not be safely removed.", 500);
    }
    this.deleteStage(canonicalExpected);
  }

  private sweepStaleStages(): number {
    if (!existsSync(this.context.stagingRoot)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.context.stagingRoot)) {
      if (!UUID_RE.test(name)) continue;
      const path = this.stagePath(name);
      let createdAt: number;
      try {
        const stageStat = lstatSync(path);
        createdAt = stageStat.mtimeMs;
        if (stageStat.isDirectory() && !stageStat.isSymbolicLink()) {
          try {
            const metadata = JSON.parse(readFileSync(join(path, "stage.json"), "utf8")) as Record<string, unknown>;
            if (metadata.version === 1 && metadata.stageId === name && metadata.homeId === this.context.homeId && typeof metadata.createdAt === "number") {
              createdAt = metadata.createdAt;
            }
          } catch { /* mtime bounds malformed crash residue */ }
        }
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      if (this.now() - createdAt <= STAGE_MAX_AGE_MS) continue;
      try {
        this.deleteStageById(name);
        removed += 1;
      } catch {
        throw new NativeProfileError("STAGING_CLEANUP_REQUIRED", "An expired native-login staging session could not be securely removed.", 500);
      }
    }
    return removed;
  }

  async prepareStage(): Promise<{ stageId: string; stagingCodexHome: string; effectiveCodexHome: string }> {
    return this.withLock(async () => {
      this.assertNoPendingRecovery();
      this.sweepStaleStages();
      requireFileCredentialStore(this.context);
      const vault = this.requireVault();
      let key: NativeProfileKey | null = null;
      let current: NativeEnvelopeSnapshot | null = null;
      try {
        key = await this.keyForVault(vault);
        current = this.readEnvelope(this.context.authPath);
        this.assertCurrentIdentity(vault, current, key);
        if (!existsSync(this.context.stagingRoot)) mkdirSync(this.context.stagingRoot, { recursive: true, mode: 0o700 });
        await this.hardenPath(dirname(this.context.stagingRoot));
        await this.hardenPath(this.context.stagingRoot);
        const stageId = this.uuid();
        const path = this.stagePath(stageId);
        mkdirSync(path, { mode: 0o700 });
        try {
          await this.hardenPath(path);
          writeFileSync(join(path, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
          await this.hardenPath(join(path, "config.toml"));
          writeFileSync(join(path, "stage.json"), serializeNativeProfileMetadata({ version: 1, stageId, homeId: this.context.homeId, createdAt: this.now() }), { mode: 0o600 });
          await this.hardenPath(join(path, "stage.json"));
        } catch (error) {
          try { rmSync(path, { recursive: true, force: true }); } catch { /* original error wins */ }
          throw error;
        }
        return { stageId, stagingCodexHome: path, effectiveCodexHome: this.context.codexHome };
      } finally {
        current?.raw.fill(0);
        key?.key.fill(0);
      }
    });
  }

  async finishStage(stageId: string, labelInput: string): Promise<{ effectiveCodexHome: string; profile: NativeProfilePublic }> {
    return this.withLock(async () => {
      this.assertNoPendingRecovery();
      this.stagePath(stageId);
      let target: NativeEnvelopeSnapshot | null = null;
      let current: NativeEnvelopeSnapshot | null = null;
      let key: NativeProfileKey | null = null;
      let operationFailed = false;
      let operationError: unknown;
      let importCommitted = false;
      let result: { effectiveCodexHome: string; profile: NativeProfilePublic } | undefined;
      try {
        const stagePath = this.verifiedStagePath(stageId);
        requireFileCredentialStore(this.context);
        const label = validateNativeProfileLabel(labelInput);
        target = readNativeEnvelope(join(stagePath, "auth.json"));
        current = readNativeEnvelope(this.context.authPath);
        const vault = this.requireVault();
        if (vault.profiles.length >= MAX_NATIVE_PROFILES) {
          throw new NativeProfileError("INVALID_REQUEST", "Native profiles are limited to 32 entries.", 400);
        }
        key = await this.keyForVault(vault);
        this.assertCurrentIdentity(vault, current, key);
        assertUniqueNativeProfileLabel(vault, label);
        const identityHash = nativeIdentityHash(key.key, target.accountId);
        if (vault.profiles.some(profile => profile.identityHash === identityHash)) {
          throw new NativeProfileError("PROFILE_ALREADY_EXISTS", "That native identity is already registered.", 409);
        }
        const timestamp = new Date(this.now()).toISOString();
        const id = this.uuid();
        const currentProfile = this.currentProfile(vault);
        const currentSourcePayload = encryptNativeEnvelope(
          this.context,
          currentProfile.id,
          currentProfile.identityHash,
          current,
          key,
        );
        const profile: NativeMainProfileRecordV1 = {
          id,
          label,
          identityHash,
          identityHint: nativeIdentityHint(identityHash),
          state: "inactive",
          payload: encryptNativeEnvelope(this.context, id, identityHash, target, key),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const prospectiveVault = structuredClone(vault);
        prospectiveVault.profiles.push(profile);
        prospectiveVault.revision += 1;
        const currentActivePreflight = structuredClone(prospectiveVault);
        currentActivePreflight.revision = Number.MAX_SAFE_INTEGER;
        serializeNativeProfileMetadata(currentActivePreflight);
        for (const inactiveProfile of prospectiveVault.profiles.filter(item => item.state === "inactive")) {
          const activePlacement = structuredClone(prospectiveVault);
          activePlacement.revision = Number.MAX_SAFE_INTEGER;
          const nextCurrent = activePlacement.profiles.find(item => item.id === currentProfile.id)!;
          const nextActive = activePlacement.profiles.find(item => item.id === inactiveProfile.id)!;
          nextCurrent.state = "inactive";
          nextCurrent.payload = currentSourcePayload;
          nextActive.state = "active";
          nextActive.payload = null;
          activePlacement.activeProfileId = nextActive.id;
          serializeNativeProfileMetadata(activePlacement);
        }
        await this.writeVault(prospectiveVault);
        importCommitted = true;
        result = { effectiveCodexHome: this.context.codexHome, profile: publicNativeProfile(profile) };
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        target?.raw.fill(0);
        current?.raw.fill(0);
        key?.key.fill(0);
      }
      let cleanupFailed = false;
      try {
        this.deleteStageById(stageId);
      } catch {
        cleanupFailed = true;
      }
      if (operationFailed) {
        if (cleanupFailed) {
          if (operationError instanceof NativeProfileError) {
            throw new NativeProfileError(
              operationError.code,
              operationError.message,
              operationError.status,
              operationError.retryable,
              true,
            );
          }
          throw new NativeProfileError(
            "INTERNAL_ERROR",
            "The native profile import failed and its staging session could not be securely removed.",
            500,
            false,
            true,
          );
        }
        throw operationError;
      }
      if (cleanupFailed) {
        throw new NativeProfileError(
          "STAGING_CLEANUP_REQUIRED",
          importCommitted
            ? "The native profile was imported, but its staging session could not be securely removed. Do not retry the import; fix filesystem permissions and cancel it explicitly."
            : "The native-login staging session could not be securely removed; fix filesystem permissions and cancel it explicitly.",
          500,
        );
      }
      return result!;
    });
  }

  async cancelStage(stageId: string): Promise<void> {
    await this.withLock(async () => {
      try { this.deleteStageById(stageId); } catch (error) {
        if (error instanceof NativeProfileError) throw error;
        throw new NativeProfileError("STAGING_CLEANUP_REQUIRED", "The native-login staging session could not be securely removed.", 500);
      }
    });
  }

  private resolveTarget(vault: NativeMainProfileVaultV1, target: string): NativeMainProfileRecordV1 {
    const normalized = target.trim().toLowerCase();
    const profile = vault.profiles.find(item => item.id.toLowerCase() === normalized || item.label.toLowerCase() === normalized);
    if (!profile) throw new NativeProfileError("PROFILE_NOT_FOUND", "The requested native profile does not exist.", 404);
    if (profile.state !== "inactive" || !profile.payload) {
      throw new NativeProfileError("INVALID_REQUEST", "The requested native profile is already active.", 400);
    }
    return profile;
  }

  private verifyWrittenEnvelope(expectedDigest: string, expectedIdentityHash: string, key: NativeProfileKey): NativeEnvelopeSnapshot {
    const observed = this.readEnvelope(this.context.authPath);
    try {
      if (observed.digest !== expectedDigest || nativeIdentityHash(key.key, observed.accountId) !== expectedIdentityHash) {
        throw new Error("auth read-back mismatch");
      }
      return observed;
    } catch (error) {
      observed.raw.fill(0);
      throw error;
    }
  }

  async switch(targetSelector: string, confirmedStopped = false): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      this.sweepStaleStages();
      requireFileCredentialStore(this.context);
      await this.assertNativeCodexStopped(confirmedStopped);
      if (probeNativeProfileRecoveryState(this.context) !== "none") await this.recoverLocked(false);
      const beforeVault = this.requireVault();
      let key: NativeProfileKey | null = null;
      let source: NativeEnvelopeSnapshot | null = null;
      let target: NativeEnvelopeSnapshot | null = null;
      let journalPrepared = false;
      let committed = false;
      try {
        key = await this.keyForVault(beforeVault);
        source = this.readEnvelope(this.context.authPath);
        const sourceProfile = this.assertCurrentIdentity(beforeVault, source, key);
        const targetProfile = this.resolveTarget(beforeVault, targetSelector);
        target = decryptNativeEnvelope(this.context, targetProfile.id, targetProfile.identityHash, targetProfile.payload!, key);
        if (nativeIdentityHash(key.key, target.accountId) !== targetProfile.identityHash) {
          throw new NativeProfileError("PROFILE_DECRYPT_FAILED", "The selected native profile identity does not match its encrypted record.", 409);
        }
        const timestamp = new Date(this.now()).toISOString();
        const sourcePayload = encryptNativeEnvelope(this.context, sourceProfile.id, sourceProfile.identityHash, source, key);
        const afterVault = structuredClone(beforeVault);
        const nextSource = afterVault.profiles.find(profile => profile.id === sourceProfile.id)!;
        const nextTarget = afterVault.profiles.find(profile => profile.id === targetProfile.id)!;
        nextSource.state = "inactive";
        nextSource.payload = sourcePayload;
        nextSource.updatedAt = timestamp;
        nextTarget.state = "active";
        nextTarget.payload = null;
        nextTarget.updatedAt = timestamp;
        afterVault.activeProfileId = nextTarget.id;
        afterVault.revision += 1;
        const journal: NativeProfileSwitchJournalV1 = {
          version: 1,
          transactionId: this.uuid(),
          homeId: this.context.homeId,
          phase: "prepared",
          sourceProfileId: sourceProfile.id,
          sourceIdentityHash: sourceProfile.identityHash,
          sourcePayload,
          targetProfileId: targetProfile.id,
          targetIdentityHash: targetProfile.identityHash,
          targetPayload: targetProfile.payload!,
          beforeVault: structuredClone(beforeVault),
          afterVault,
          createdAt: timestamp,
        };
        serializeNativeProfileMetadata(afterVault);
        serializeNativeProfileJournal({ ...journal, phase: "prepared" });
        serializeNativeProfileJournal({ ...journal, phase: "auth-replaced" });
        serializeNativeProfileJournal({ ...journal, phase: "vault-committed" });
        await this.writeJournal(journal);
        journalPrepared = true;
        await this.onSwitchBoundary("journal-prepared");
        await this.atomicWrite(this.context.authPath, target.text);
        const observedTarget = this.verifyWrittenEnvelope(target.digest, targetProfile.identityHash, key);
        observedTarget.raw.fill(0);
        await this.onSwitchBoundary("auth-replaced");
        journal.phase = "auth-replaced";
        await this.writeJournal(journal);
        await this.writeVault(afterVault);
        committed = true;
        await this.onSwitchBoundary("vault-committed");
        journal.phase = "vault-committed";
        await this.writeJournal(journal);
        this.applyTransition(source.accountId, target.accountId);
        await this.onSwitchBoundary("runtime-transition-published");
        this.removeJournal();
        await this.onSwitchBoundary("journal-deleted");
        return {
          ok: true,
          effectiveCodexHome: this.context.codexHome,
          activeProfile: publicNativeProfile(nextTarget),
          restartRequired: true,
        };
      } catch (cause) {
        if (!journalPrepared) throw cause;
        if (committed) {
          throw new NativeProfileError("RECOVERY_REQUIRED", "The login changed, but final transaction cleanup requires recovery.", 409);
        }
        try {
          await this.atomicWrite(this.context.authPath, source!.text);
          const restored = this.verifyWrittenEnvelope(source!.digest, nativeIdentityHash(key!.key, source!.accountId), key!);
          restored.raw.fill(0);
          await this.writeVault(beforeVault);
          this.removeJournal();
        } catch {
          throw new NativeProfileError(
            "AUTH_RESTORE_FAILED",
            "The original native login could not be verified after rollback; the encrypted recovery journal was retained.",
            500,
          );
        }
        throw new NativeProfileError("SWITCH_ROLLED_BACK", "The native-login switch failed and the exact original login was restored.", 409);
      } finally {
        source?.raw.fill(0);
        target?.raw.fill(0);
        key?.key.fill(0);
      }
    });
  }

  private async recoverLocked(rollback: boolean): Promise<Record<string, unknown>> {
    const inspection = inspectNativeProfileJournal(this.context);
    const recoveryState = probeNativeProfileRecoveryState(this.context);
    if (inspection.status === "invalid" || recoveryState === "unreadable") {
      throw new NativeProfileError(
        "RECOVERY_REQUIRED",
        "The native-profile recovery state is invalid and requires explicit confirmed rollback quarantine.",
        409,
      );
    }
    if (recoveryState === "manual") {
      if (inspection.status !== "missing") {
        throw new NativeProfileError("RECOVERY_REQUIRED", "Manual native-profile recovery remains pending.", 409);
      }
      return this.clearRecoveryBlockLocked();
    }
    const journal = inspection.status === "valid" ? inspection.journal : null;
    if (!journal) {
      return {
        ok: true,
        recovered: false,
        externallyRefreshed: false,
        effectiveCodexHome: this.context.codexHome,
      };
    }
    let key: NativeProfileKey | null = null;
    let current: ReturnType<typeof readNativeEnvelopeResult> | null = null;
    let sourceEnvelope: NativeEnvelopeSnapshot | null = null;
    try {
      key = await this.keyForVault(journal.beforeVault);
      current = readNativeEnvelopeResult(this.context.authPath);
      if (current.status !== "ok") {
        throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery stopped because the current native login is not readable and confirmed.", 409);
      }
      const currentHash = nativeIdentityHash(key.key, current.envelope.accountId);
      if (rollback) {
        if (currentHash === journal.sourceIdentityHash) {
          await this.writeVault(journal.beforeVault);
          this.removeJournal();
          return {
            ok: true,
            recovered: true,
            action: "rollback-source",
            externallyRefreshed: current.envelope.digest !== journal.sourcePayload.envelopeSha256,
            effectiveCodexHome: this.context.codexHome,
            restartRequired: false,
          };
        }
        if (currentHash !== journal.targetIdentityHash) {
          throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery found a third or unknown native identity and made no credential write.", 409);
        }
        sourceEnvelope = decryptNativeEnvelope(
          this.context,
          journal.sourceProfileId,
          journal.sourceIdentityHash,
          journal.sourcePayload,
          key,
        );
        let rollbackVault = journal.beforeVault;
        const externallyRefreshed = current.envelope.digest !== journal.targetPayload.envelopeSha256;
        let rollbackVaultPublished = false;
        if (current.envelope.digest !== journal.targetPayload.envelopeSha256) {
          rollbackVault = structuredClone(journal.beforeVault);
          const targetProfile = rollbackVault.profiles.find(profile =>
            profile.id === journal.targetProfileId
            && profile.identityHash === journal.targetIdentityHash
            && profile.state === "inactive"
          );
          if (!targetProfile) {
            throw new NativeProfileError(
              "VAULT_INVALID",
              "Recovery could not preserve the refreshed target login in its inactive profile and made no credential write.",
              409,
            );
          }
          const refreshedTargetPayload = encryptNativeEnvelope(
            this.context,
            targetProfile.id,
            targetProfile.identityHash,
            current.envelope,
            key,
          );
          targetProfile.payload = refreshedTargetPayload;
          targetProfile.updatedAt = new Date(this.now()).toISOString();
          rollbackVault.revision += 1;
          const preservedJournal = structuredClone(journal);
          preservedJournal.targetPayload = refreshedTargetPayload;
          preservedJournal.beforeVault = structuredClone(rollbackVault);
          await this.writeJournal(preservedJournal);
          await this.writeVault(rollbackVault);
          rollbackVaultPublished = true;
        }
        await this.atomicWrite(this.context.authPath, sourceEnvelope.text);
        const restored = this.verifyWrittenEnvelope(sourceEnvelope.digest, journal.sourceIdentityHash, key);
        restored.raw.fill(0);
        if (!rollbackVaultPublished) await this.writeVault(rollbackVault);
        this.applyTransition(current.envelope.accountId, sourceEnvelope.accountId);
        this.removeJournal();
        return {
          ok: true,
          recovered: true,
          action: "rollback-source",
          externallyRefreshed,
          effectiveCodexHome: this.context.codexHome,
          restartRequired: true,
        };
      }
      const observation = currentHash === journal.sourceIdentityHash
        ? { identity: "source" as const, digest: current.envelope.digest === journal.sourcePayload.envelopeSha256 ? "exact" as const : "changed" as const }
        : currentHash === journal.targetIdentityHash
          ? { identity: "target" as const, digest: current.envelope.digest === journal.targetPayload.envelopeSha256 ? "exact" as const : "changed" as const }
          : { identity: "other" as const, digest: "unknown" as const };
      const decision = decideNativeProfileRecovery(journal.phase, observation);
      if (decision.action === "manual-recovery") {
        throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery found a third or unknown native identity and made no credential write.", 409);
      }
      if (decision.action === "rollback-source") {
        await this.writeVault(journal.beforeVault);
        this.removeJournal();
        return {
          ok: true,
          recovered: true,
          action: decision.action,
          externallyRefreshed: decision.externallyRefreshed,
          effectiveCodexHome: this.context.codexHome,
          restartRequired: false,
        };
      }
      sourceEnvelope = decryptNativeEnvelope(
        this.context,
        journal.sourceProfileId,
        journal.sourceIdentityHash,
        journal.sourcePayload,
        key,
      );
      await this.writeVault(journal.afterVault);
      this.applyTransition(sourceEnvelope.accountId, current.envelope.accountId);
      this.removeJournal();
      return {
        ok: true,
        recovered: true,
        action: decision.action,
        externallyRefreshed: decision.externallyRefreshed,
        effectiveCodexHome: this.context.codexHome,
        restartRequired: true,
      };
    } finally {
      if (current?.status === "ok") current.envelope.raw.fill(0);
      sourceEnvelope?.raw.fill(0);
      key?.key.fill(0);
    }
  }

  async recover(rollback = false, confirmedStopped = false): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      requireFileCredentialStore(this.context);
      const inspection = inspectNativeProfileJournal(this.context);
      if (inspection.status === "invalid") {
        if (!rollback) {
          throw new NativeProfileError(
            "RECOVERY_REQUIRED",
            "The invalid native-profile recovery journal requires recover --rollback --yes.",
            409,
          );
        }
        await this.assertNativeCodexStopped(confirmedStopped);
        return this.quarantineInvalidJournalLocked();
      }
      if (rollback && inspection.status === "valid") {
        await this.assertNativeCodexStopped(confirmedStopped);
      }
      return this.recoverLocked(rollback);
    });
  }
}
