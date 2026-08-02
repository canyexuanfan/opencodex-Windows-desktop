import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
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
  nativeIdentityHash,
  nativeIdentityHint,
  OsNativeProfileKeyProvider,
  publicNativeProfile,
  readNativeEnvelope,
  readNativeEnvelopeResult,
  readNativeProfileJournal,
  readNativeProfileVault,
  requireFileCredentialStore,
  resolveNativeCredentialStoreMode,
  resolveNativeProfileContext,
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
const LOCK_METADATA_GRACE_MS = 1_000;
const LOCK_STALE_MS = 10 * 60_000;
const STAGE_MAX_AGE_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AtomicWriter = (path: string, content: string) => Promise<void>;
type TransitionApplier = (fromAccountId: string, toAccountId: string) => void;

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

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  }

  private async ensureRoot(): Promise<void> {
    if (!existsSync(this.context.rootDir)) mkdirSync(this.context.rootDir, { recursive: true, mode: 0o700 });
    await this.hardenPath(this.context.rootDir);
  }

  private isLockStale(): boolean {
    const observedAt = this.now();
    let pathAgeMs: number;
    try {
      pathAgeMs = Math.max(0, observedAt - lstatSync(this.context.lockPath).mtimeMs);
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
    try {
      const lock = JSON.parse(readFileSync(this.context.lockPath, "utf8")) as { pid?: unknown; acquiredAt?: unknown };
      if (typeof lock.pid === "number" && processAlive(lock.pid)) return false;
      return typeof lock.acquiredAt === "number"
        ? observedAt - lock.acquiredAt > LOCK_STALE_MS
        : pathAgeMs > LOCK_METADATA_GRACE_MS;
    } catch {
      return pathAgeMs > LOCK_METADATA_GRACE_MS;
    }
  }

  private releaseLock(ownerToken: string): void {
    try {
      const lock = JSON.parse(readFileSync(this.context.lockPath, "utf8")) as { ownerToken?: unknown };
      if (lock.ownerToken !== ownerToken) return;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      return;
    }
    try { unlinkSync(this.context.lockPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    const deadline = this.now() + LOCK_WAIT_MS;
    let ownerToken: string | null = null;
    while (ownerToken === null) {
      const candidateToken = this.uuid();
      const candidatePath = `${this.context.lockPath}.${candidateToken}.candidate`;
      let candidateFd: number | null = null;
      try {
        candidateFd = openSync(candidatePath, "wx", 0o600);
        writeFileSync(candidateFd, serializeNativeProfileMetadata({
          pid: process.pid,
          acquiredAt: this.now(),
          homeId: this.context.homeId,
          ownerToken: candidateToken,
        }));
        closeSync(candidateFd);
        candidateFd = null;
        await this.hardenPath(candidatePath);
        linkSync(candidatePath, this.context.lockPath);
        unlinkSync(candidatePath);
        ownerToken = candidateToken;
      } catch (error) {
        if (candidateFd !== null) try { closeSync(candidateFd); } catch { /* reported below */ }
        try { unlinkSync(candidatePath); } catch (cleanupError) { if (errorCode(cleanupError) !== "ENOENT") { /* reported below */ } }
        if (errorCode(error) !== "EEXIST") {
          try { this.releaseLock(candidateToken); } catch { /* reported below */ }
          throw new NativeProfileError("PROFILE_LOCK_UNAVAILABLE", "The native-profile lock is unavailable.", 503, true);
        }
        if (this.isLockStale()) {
          try { unlinkSync(this.context.lockPath); } catch (unlinkError) { if (errorCode(unlinkError) !== "ENOENT") throw unlinkError; }
          continue;
        }
        if (this.now() >= deadline) {
          throw new NativeProfileError("PROFILE_LOCK_UNAVAILABLE", "Another native-profile operation is still running.", 503, true);
        }
        await this.sleep(50);
      }
    }
    try {
      return await operation();
    } finally {
      this.releaseLock(ownerToken);
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
    await this.atomicWrite(this.context.journalPath, serializeNativeProfileMetadata(journal));
  }

  private removeJournal(): void {
    try { unlinkSync(this.context.journalPath); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }

  private requireVault(): NativeMainProfileVaultV1 {
    const vault = readNativeProfileVault(this.context);
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
      requireFileCredentialStore(this.context);
      const label = validateNativeProfileLabel(labelInput);
      const envelope = readNativeEnvelope(this.context.authPath);
      let vault = readNativeProfileVault(this.context);
      const key = await this.keyForVault(vault);
      try {
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
        envelope.raw.fill(0);
        key.key.fill(0);
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
    const mode = (() => {
      try { return resolveNativeCredentialStoreMode(this.context); } catch { return "unknown"; }
    })();
    const auth = readNativeEnvelopeResult(this.context.authPath);
    const vault = readNativeProfileVault(this.context);
    let keyStore: "available" | "missing-key" | "unavailable" = "available";
    try {
      const key = await this.keyProvider.get(this.context.homeId);
      if (vault && !key) keyStore = "missing-key";
      if (key) key.key.fill(0);
    } catch {
      keyStore = "unavailable";
    }
    let stagingCount = 0;
    try {
      if (existsSync(this.context.stagingRoot)) {
        stagingCount = Array.from(new Bun.Glob("*").scanSync({ cwd: this.context.stagingRoot, onlyFiles: false })).length;
      }
    } catch { stagingCount = 0; }
    return {
      effectiveCodexHome: this.context.codexHome,
      credentialStoreMode: mode,
      supported: mode === "file",
      authStatus: auth.status,
      keyStore,
      profileCount: vault?.profiles.length ?? 0,
      activeProfileId: vault?.activeProfileId ?? null,
      recoveryPending: existsSync(this.context.journalPath),
      stagingCount,
    };
  }

  private stagePath(stageId: string): string {
    if (!UUID_RE.test(stageId)) throw new NativeProfileError("INVALID_REQUEST", "The staging identifier is invalid.", 400);
    return join(this.context.stagingRoot, stageId);
  }

  private verifiedStagePath(stageId: string): string {
    const expected = resolve(this.stagePath(stageId));
    try {
      if (lstatSync(expected).isSymbolicLink() || !lstatSync(expected).isDirectory()) throw new Error("stage type");
      const canonicalRoot = resolve(realpathSync.native(this.context.stagingRoot));
      const canonicalExpected = resolve(realpathSync.native(expected));
      const rel = relative(canonicalRoot, canonicalExpected);
      if (!rel || rel.startsWith("..") || rel.includes(sep)) throw new Error("stage root");
      const metadata = JSON.parse(readFileSync(join(canonicalExpected, "stage.json"), "utf8")) as Record<string, unknown>;
      if (metadata.version !== 1 || metadata.stageId !== stageId || metadata.homeId !== this.context.homeId) throw new Error("stage metadata");
      if (typeof metadata.createdAt !== "number" || this.now() - metadata.createdAt > STAGE_MAX_AGE_MS) throw new Error("stage age");
      return canonicalExpected;
    } catch {
      throw new NativeProfileError("STAGING_NOT_FOUND", "The native-login staging session is missing, expired, or invalid.", 404);
    }
  }

  private deleteStage(path: string): void {
    const authPath = join(path, "auth.json");
    if (existsSync(authPath)) truncateSync(authPath, 0);
    rmSync(path, { recursive: true, force: false });
  }

  async prepareStage(): Promise<{ stageId: string; stagingCodexHome: string; effectiveCodexHome: string }> {
    return this.withLock(async () => {
      requireFileCredentialStore(this.context);
      const vault = this.requireVault();
      const key = await this.keyForVault(vault);
      const current = readNativeEnvelope(this.context.authPath);
      try { this.assertCurrentIdentity(vault, current, key); } finally { current.raw.fill(0); key.key.fill(0); }
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
    });
  }

  async finishStage(stageId: string, labelInput: string): Promise<{ effectiveCodexHome: string; profile: NativeProfilePublic }> {
    return this.withLock(async () => {
      requireFileCredentialStore(this.context);
      const label = validateNativeProfileLabel(labelInput);
      const stagePath = this.verifiedStagePath(stageId);
      const target = readNativeEnvelope(join(stagePath, "auth.json"));
      const current = readNativeEnvelope(this.context.authPath);
      const vault = this.requireVault();
      const key = await this.keyForVault(vault);
      try {
        this.assertCurrentIdentity(vault, current, key);
        assertUniqueNativeProfileLabel(vault, label);
        const identityHash = nativeIdentityHash(key.key, target.accountId);
        if (vault.profiles.some(profile => profile.identityHash === identityHash)) {
          throw new NativeProfileError("PROFILE_ALREADY_EXISTS", "That native identity is already registered.", 409);
        }
        const timestamp = new Date(this.now()).toISOString();
        const id = this.uuid();
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
        vault.profiles.push(profile);
        vault.revision += 1;
        await this.writeVault(vault);
        try {
          this.deleteStage(stagePath);
        } catch {
          throw new NativeProfileError(
            "STAGING_CLEANUP_REQUIRED",
            "The profile was encrypted, but the restricted staging credential could not be removed; run recover after fixing filesystem permissions.",
            500,
          );
        }
        return { effectiveCodexHome: this.context.codexHome, profile: publicNativeProfile(profile) };
      } finally {
        target.raw.fill(0);
        current.raw.fill(0);
        key.key.fill(0);
      }
    });
  }

  async cancelStage(stageId: string): Promise<void> {
    await this.withLock(async () => { this.deleteStage(this.verifiedStagePath(stageId)); });
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
    const observed = readNativeEnvelope(this.context.authPath);
    if (observed.digest !== expectedDigest || nativeIdentityHash(key.key, observed.accountId) !== expectedIdentityHash) {
      observed.raw.fill(0);
      throw new Error("auth read-back mismatch");
    }
    return observed;
  }

  async switch(targetSelector: string, confirmedStopped = false): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      requireFileCredentialStore(this.context);
      await this.assertNativeCodexStopped(confirmedStopped);
      if (readNativeProfileJournal(this.context)) await this.recoverLocked(false);
      const beforeVault = this.requireVault();
      const key = await this.keyForVault(beforeVault);
      const source = readNativeEnvelope(this.context.authPath);
      let target: NativeEnvelopeSnapshot | null = null;
      let journalPrepared = false;
      let committed = false;
      try {
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
        await this.writeJournal(journal);
        journalPrepared = true;
        await this.atomicWrite(this.context.authPath, target.text);
        const observedTarget = this.verifyWrittenEnvelope(target.digest, targetProfile.identityHash, key);
        observedTarget.raw.fill(0);
        journal.phase = "auth-replaced";
        await this.writeJournal(journal);
        await this.writeVault(afterVault);
        committed = true;
        journal.phase = "vault-committed";
        await this.writeJournal(journal);
        this.applyTransition(source.accountId, target.accountId);
        this.removeJournal();
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
          await this.atomicWrite(this.context.authPath, source.text);
          const restored = this.verifyWrittenEnvelope(source.digest, nativeIdentityHash(key.key, source.accountId), key);
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
        source.raw.fill(0);
        target?.raw.fill(0);
        key.key.fill(0);
      }
    });
  }

  private async recoverLocked(rollback: boolean): Promise<Record<string, unknown>> {
    const journal = readNativeProfileJournal(this.context);
    if (!journal) return { ok: true, recovered: false, effectiveCodexHome: this.context.codexHome };
    const key = await this.keyForVault(journal.beforeVault);
    const current = readNativeEnvelopeResult(this.context.authPath);
    if (current.status !== "ok") {
      key.key.fill(0);
      throw new NativeProfileError("RECOVERY_REQUIRED", "Recovery stopped because the current native login is not readable and confirmed.", 409);
    }
    let sourceEnvelope: NativeEnvelopeSnapshot | null = null;
    try {
      const currentHash = nativeIdentityHash(key.key, current.envelope.accountId);
      if (rollback) {
        if (currentHash === journal.sourceIdentityHash) {
          await this.writeVault(journal.beforeVault);
          this.removeJournal();
          return { ok: true, recovered: true, action: "rollback-source", effectiveCodexHome: this.context.codexHome, restartRequired: false };
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
        await this.atomicWrite(this.context.authPath, sourceEnvelope.text);
        const restored = this.verifyWrittenEnvelope(sourceEnvelope.digest, journal.sourceIdentityHash, key);
        restored.raw.fill(0);
        await this.writeVault(journal.beforeVault);
        this.applyTransition(current.envelope.accountId, sourceEnvelope.accountId);
        this.removeJournal();
        return { ok: true, recovered: true, action: "rollback-source", effectiveCodexHome: this.context.codexHome, restartRequired: true };
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
        return { ok: true, recovered: true, action: decision.action, effectiveCodexHome: this.context.codexHome, restartRequired: false };
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
      return { ok: true, recovered: true, action: decision.action, effectiveCodexHome: this.context.codexHome, restartRequired: true };
    } finally {
      current.envelope.raw.fill(0);
      sourceEnvelope?.raw.fill(0);
      key.key.fill(0);
    }
  }

  async recover(rollback = false, confirmedStopped = false): Promise<Record<string, unknown>> {
    return this.withLock(async () => {
      requireFileCredentialStore(this.context);
      if (rollback && readNativeProfileJournal(this.context)) {
        await this.assertNativeCodexStopped(confirmedStopped);
      }
      return this.recoverLocked(rollback);
    });
  }
}
