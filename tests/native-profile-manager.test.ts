import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NativeProfileManager } from "../src/codex/native-profile-manager";
import {
  decryptNativeEnvelope,
  MAX_NATIVE_PROFILE_JOURNAL_BYTES,
  MAX_NATIVE_PROFILE_METADATA_BYTES,
  probeNativeProfileRecoveryState,
  readNativeProfileVault,
} from "../src/codex/native-profile-store";
import { NativeProfileError, type NativeProfileKey, type NativeProfileKeyProvider } from "../src/codex/native-profile-types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  private readonly keys = new Map<string, Buffer>();
  async get(homeId: string): Promise<NativeProfileKey | null> {
    const key = this.keys.get(homeId);
    return key ? { keyRef: `memory:${homeId}`, key: Buffer.from(key) } : null;
  }
  async create(homeId: string): Promise<NativeProfileKey> {
    const key = Buffer.alloc(32, 7);
    this.keys.set(homeId, key);
    return { keyRef: `memory:${homeId}`, key: Buffer.from(key) };
  }
}

function envelope(accountId: string, marker: string): string {
  return ` {\n  \"auth_mode\": \"chatgpt\",\n  \"tokens\": {\n    \"id_token\": \"opaque-id-${marker}\",\n    \"access_token\": \"opaque-access-${marker}\",\n    \"refresh_token\": \"opaque-refresh-${marker}\",\n    \"account_id\": \"${accountId}\",\n    \"future_token_field\": \"preserve-${marker}\"\n  },\n  \"future_root_field\": { \"marker\": \"${marker}\" }\n}\n`;
}

async function atomic(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.test.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

function hasJournalPhase(content: string, phase: string): boolean {
  return (JSON.parse(content) as { phase?: unknown }).phase === phase;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-profile-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  const source = envelope("account-source", "source");
  const target = envelope("account-target", "target");
  writeFileSync(join(codexHome, "auth.json"), source);
  const keyProvider = new MemoryKeyProvider();
  const transitions: string[] = [];
  const options = {
    codexHome,
    configDir,
    keyProvider,
    atomicWrite: atomic,
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear" as const, count: 0 as const }),
    applyTransition: (from: string, to: string) => transitions.push(`${from}->${to}`),
  };
  return { root, codexHome, configDir, source, target, keyProvider, transitions, options };
}

async function enrolledFixture() {
  const f = fixture();
  const manager = new NativeProfileManager(f.options);
  const sourceProfile = await manager.register("personal");
  const stage = await manager.prepareStage();
  writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
  const targetProfile = await manager.finishStage(stage.stageId, "work");
  return { ...f, manager, sourceProfile: sourceProfile.profile, targetProfile: targetProfile.profile, stage };
}

async function leavePendingJournal(f: Awaited<ReturnType<typeof enrolledFixture>>): Promise<NativeProfileManager> {
  const authPath = f.manager.context.authPath;
  const journalPath = f.manager.context.journalPath;
  let authWrites = 0;
  const interrupted = new NativeProfileManager({
    ...f.options,
    atomicWrite: async (path, content) => {
      if (path === authPath) {
        authWrites += 1;
        if (authWrites > 1) throw new Error("injected restore failure");
      }
      if (path === journalPath && hasJournalPhase(content, "auth-replaced")) {
        throw new Error("injected post-replacement failure");
      }
      return atomic(path, content);
    },
  });
  let caught: unknown;
  try { await interrupted.switch("work", true); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(NativeProfileError);
  expect((caught as NativeProfileError).code).toBe("AUTH_RESTORE_FAILED");
  expect(existsSync(journalPath)).toBe(true);
  return interrupted;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`Timed out waiting for child marker ${path}`);
}

function spawnLockHolder(
  f: ReturnType<typeof fixture>,
  readyPath: string,
  releasePath: string,
  options: { crash?: boolean; contention?: string } = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-lock-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NATIVE_PROFILE_TEST_CODEX_HOME: f.codexHome,
      NATIVE_PROFILE_TEST_CONFIG_DIR: f.configDir,
      NATIVE_PROFILE_TEST_READY: readyPath,
      NATIVE_PROFILE_TEST_RELEASE: releasePath,
      NATIVE_PROFILE_TEST_CRASH: options.crash ? "1" : "0",
      ...(options.contention ? { NATIVE_PROFILE_TEST_CONTENTION: options.contention } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("native main profile transactions", () => {
  test("an abruptly exited child releases the OS-backed profile transaction", async () => {
    const f = fixture();
    const readyPath = join(f.root, "crash-ready");
    const child = spawnLockHolder(f, readyPath, join(f.root, "unused-release"), { crash: true });
    await waitForPath(readyPath);
    expect(await child.exited).toBe(87);

    const successor = new NativeProfileManager({ ...f.options, lockWaitMs: 250 });
    expect((await successor.recover(false)).recovered).toBe(false);
  }, 15_000);

  test("two processes exclude each other and predecessor release cannot delete a successor lock", async () => {
    const f = fixture();
    const firstReady = join(f.root, "first-ready");
    const firstRelease = join(f.root, "first-release");
    const secondReady = join(f.root, "second-ready");
    const secondRelease = join(f.root, "second-release");
    const secondContention = join(f.root, "second-contention");
    const first = spawnLockHolder(f, firstReady, firstRelease);
    let second: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await waitForPath(firstReady);
      second = spawnLockHolder(f, secondReady, secondRelease, { contention: secondContention });
      await waitForPath(secondContention);
      expect(existsSync(secondReady)).toBe(false);

      writeFileSync(firstRelease, "release");
      expect(await first.exited).toBe(0);
      await waitForPath(secondReady);

      const contender = new NativeProfileManager({ ...f.options, lockWaitMs: 100 });
      let caught: unknown;
      try { await contender.recover(false); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(NativeProfileError);
      expect((caught as NativeProfileError).code).toBe("NATIVE_PROFILE_BUSY");
      expect((caught as NativeProfileError).retryable).toBe(true);

      writeFileSync(secondRelease, "release");
      expect(await second.exited).toBe(0);
      expect((await contender.recover(false)).recovered).toBe(false);
    } finally {
      try { writeFileSync(firstRelease, "release"); } catch { /* fixture cleanup */ }
      try { writeFileSync(secondRelease, "release"); } catch { /* fixture cleanup */ }
      if (first.exitCode === null) first.kill();
      if (second?.exitCode === null) second.kill();
      await first.exited;
      if (second) await second.exited;
    }
  }, 15_000);

  test("the same canonical CODEX_HOME serializes different OpenCodex config roots", async () => {
    const f = fixture();
    const secondConfigDir = join(f.root, "opencodex-second");
    mkdirSync(secondConfigDir, { recursive: true });
    const ready = join(f.root, "canonical-home-ready");
    const release = join(f.root, "canonical-home-release");
    const first = spawnLockHolder(f, ready, release);
    try {
      await waitForPath(ready);
      const contender = new NativeProfileManager({ ...f.options, configDir: secondConfigDir, lockWaitMs: 100 });
      expect(contender.context.lockPath).toBe(new NativeProfileManager(f.options).context.lockPath);
      let caught: unknown;
      try { await contender.recover(false); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(NativeProfileError);
      expect((caught as NativeProfileError).code).toBe("NATIVE_PROFILE_BUSY");
    } finally {
      writeFileSync(release, "release");
      await first.exited;
    }
  }, 15_000);

  test("finish removes staging after auth validation failure", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), "{}\n");

    let caught: unknown;
    try { await manager.finishStage(stage.stageId, "invalid"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).cleanupRequired).toBeUndefined();
    expect(existsSync(stage.stagingCodexHome)).toBe(false);
  });

  test("finish removes staging after vault persistence failure", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
    const failing = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === manager.context.vaultPath) throw new Error("injected vault failure");
        return atomic(path, content);
      },
    });

    let caught: unknown;
    try { await failing.finishStage(stage.stageId, "work"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(existsSync(stage.stagingCodexHome)).toBe(false);
  });

  test("expired stages can be cancelled and are swept before preparing another stage", async () => {
    const f = fixture();
    let now = Date.now();
    const manager = new NativeProfileManager({ ...f.options, now: () => now });
    await manager.register("personal");
    const cancelled = await manager.prepareStage();
    writeFileSync(join(cancelled.stagingCodexHome, "auth.json"), f.target);
    now += 31 * 60_000;
    await manager.cancelStage(cancelled.stageId);
    expect(existsSync(cancelled.stagingCodexHome)).toBe(false);

    const stale = await manager.prepareStage();
    writeFileSync(join(stale.stagingCodexHome, "auth.json"), f.target);
    now += 31 * 60_000;
    const fresh = await manager.prepareStage();
    expect(existsSync(stale.stagingCodexHome)).toBe(false);
    expect(existsSync(fresh.stagingCodexHome)).toBe(true);
    await manager.cancelStage(fresh.stageId);
  });

  test("finish reports cleanup failure instead of claiming success", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
    const failing = new NativeProfileManager({
      ...f.options,
      removeStageTree: () => { throw new Error("injected cleanup failure"); },
    });

    let caught: unknown;
    try { await failing.finishStage(stage.stageId, "work"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("STAGING_CLEANUP_REQUIRED");
    expect((caught as NativeProfileError).message).toContain("was imported");
    expect((caught as NativeProfileError).message).toContain("Do not retry");
    expect((caught as NativeProfileError).cleanupRequired).toBeUndefined();
    expect((await manager.list()).profiles.some(profile => profile.label === "work")).toBe(true);
    expect(existsSync(stage.stagingCodexHome)).toBe(true);
    await manager.cancelStage(stage.stageId);
  });

  test("finish preserves the primary validation error when cleanup also fails", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), "{}\n");
    const failing = new NativeProfileManager({
      ...f.options,
      removeStageTree: () => { throw new Error("injected cleanup failure"); },
    });
    let caught: unknown;
    try { await failing.finishStage(stage.stageId, "invalid"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("AUTH_INVALID");
    expect((caught as NativeProfileError).status).toBe(409);
    expect((caught as NativeProfileError).retryable).toBe(false);
    expect((caught as NativeProfileError).cleanupRequired).toBe(true);
    expect(existsSync(stage.stagingCodexHome)).toBe(true);
    await manager.cancelStage(stage.stageId);
  });

  test("doctor degrades for corrupt vaults and stale-stage cleanup failures", async () => {
    const f = fixture();
    let now = Date.now();
    const manager = new NativeProfileManager({ ...f.options, now: () => now });
    const registered = await manager.register("personal");
    expect(await manager.doctor()).toMatchObject({
      vaultStatus: "ok",
      profileCount: 1,
      activeProfileId: registered.profile.id,
      stagingSweep: "ok",
    });
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
    now += 31 * 60_000;
    const degraded = new NativeProfileManager({
      ...f.options,
      now: () => now,
      removeStageTree: () => { throw new Error("injected cleanup failure"); },
    });
    expect(await degraded.doctor()).toMatchObject({
      vaultStatus: "ok",
      stagingSweep: "cleanup-required",
      stagingCount: 1,
    });
    await manager.cancelStage(stage.stageId);
    writeFileSync(manager.context.vaultPath, "{invalid-json\n");
    expect(await manager.doctor()).toMatchObject({
      vaultStatus: "invalid",
      profileCount: null,
      activeProfileId: null,
    });
  });

  test("rejects Unicode format labels and canonicalizes NFC before uniqueness", async () => {
    for (const bad of ["work\u202E", "work\u2066", "work\u200E", "work\u200D", "\uFEFFwork"]) {
      const f = fixture();
      const manager = new NativeProfileManager(f.options);
      let caught: unknown;
      try { await manager.register(bad); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(NativeProfileError);
      expect((caught as NativeProfileError).code).toBe("INVALID_REQUEST");
      expect(existsSync(manager.context.vaultPath)).toBe(false);
    }
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    const registered = await manager.register("개인 Cafe\u0301");
    expect(registered.profile.label).toBe("개인 Café");
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), f.target);
    let duplicate: unknown;
    try { await manager.finishStage(stage.stageId, "개인 Café"); } catch (error) { duplicate = error; }
    expect(duplicate).toBeInstanceOf(NativeProfileError);
    expect((duplicate as NativeProfileError).code).toBe("PROFILE_ALREADY_EXISTS");
  });

  test("allows 32 profiles and rejects profile 33 without changing the vault", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    for (let index = 1; index < 32; index += 1) {
      const stage = await manager.prepareStage();
      writeFileSync(join(stage.stagingCodexHome, "auth.json"), envelope("account-" + index, "profile-" + index));
      await manager.finishStage(stage.stageId, "profile-" + index);
    }
    expect((await manager.list()).profiles).toHaveLength(32);
    const vaultBefore = readFileSync(manager.context.vaultPath, "utf8");
    const overflow = await manager.prepareStage();
    writeFileSync(join(overflow.stagingCodexHome, "auth.json"), envelope("account-overflow", "overflow"));
    let caught: unknown;
    try { await manager.finishStage(overflow.stageId, "overflow"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("INVALID_REQUEST");
    expect(readFileSync(manager.context.vaultPath, "utf8")).toBe(vaultBefore);
    expect((await manager.list()).profiles).toHaveLength(32);
    expect(existsSync(overflow.stagingCodexHome)).toBe(false);
  }, 30_000);

  test("switches with a journal larger than the metadata cap", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    const stage = await manager.prepareStage();
    const large = JSON.parse(f.target) as Record<string, unknown>;
    large.padding = "x".repeat(Math.floor(MAX_NATIVE_PROFILE_METADATA_BYTES * 0.42));
    const largeTarget = JSON.stringify(large, null, 2) + "\n";
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), largeTarget);
    const work = await manager.finishStage(stage.stageId, "work");
    const switched = await manager.switch("work", true);
    expect(readFileSync(manager.context.authPath, "utf8")).toBe(largeTarget);
    expect((switched.activeProfile as { id: string }).id).toBe(work.profile.id);
    expect((await manager.list()).activeProfileId).toBe(work.profile.id);
    expect(existsSync(manager.context.journalPath)).toBe(false);
    expect(f.transitions).toEqual(["account-source->account-target"]);

    await manager.switch("personal", true);
    const authPath = manager.context.authPath;
    const journalPath = manager.context.journalPath;
    let authWrites = 0;
    const interrupted = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === authPath && authWrites++ > 0) throw new Error("injected restore failure");
        if (path === journalPath && hasJournalPhase(content, "auth-replaced")) {
          throw new Error("injected post-replacement failure");
        }
        return atomic(path, content);
      },
    });
    let interruptedError: unknown;
    try { await interrupted.switch("work", true); } catch (error) { interruptedError = error; }
    expect(interruptedError).toBeInstanceOf(NativeProfileError);
    expect((interruptedError as NativeProfileError).code).toBe("AUTH_RESTORE_FAILED");
    const persistedJournal = readFileSync(journalPath, "utf8");
    expect(Buffer.byteLength(persistedJournal)).toBeGreaterThan(MAX_NATIVE_PROFILE_METADATA_BYTES);
    expect(Buffer.byteLength(persistedJournal)).toBeLessThanOrEqual(MAX_NATIVE_PROFILE_JOURNAL_BYTES);
    expect(readFileSync(authPath, "utf8")).toBe(largeTarget);
    const vaultBeforeRecovery = readFileSync(manager.context.vaultPath, "utf8");

    expect(await manager.recover(false)).toMatchObject({
      recovered: true,
      action: "commit-target",
      externallyRefreshed: false,
    });
    expect(readFileSync(authPath, "utf8")).toBe(largeTarget);
    expect(readFileSync(manager.context.vaultPath, "utf8")).not.toBe(vaultBeforeRecovery);
    expect((await manager.list()).activeProfileId).toBe(work.profile.id);
    expect(existsSync(journalPath)).toBe(false);
  }, 30_000);

  test("fails closed for an oversized on-disk journal without mutating auth or vault", async () => {
    const f = await enrolledFixture();
    const authBefore = readFileSync(f.manager.context.authPath, "utf8");
    const vaultBefore = readFileSync(f.manager.context.vaultPath, "utf8");
    writeFileSync(f.manager.context.journalPath, "x".repeat(MAX_NATIVE_PROFILE_JOURNAL_BYTES + 1));

    let caught: unknown;
    try { await f.manager.switch("work", true); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("RECOVERY_REQUIRED");
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(authBefore);
    expect(readFileSync(f.manager.context.vaultPath, "utf8")).toBe(vaultBefore);
  }, 30_000);

  test("quarantines malformed journals byte-for-byte and keeps ownership fail closed", async () => {
    const f = await enrolledFixture();
    const malformed = "{malformed-journal\n";
    writeFileSync(f.manager.context.journalPath, malformed);
    writeFileSync(f.manager.context.authPath, f.target);
    const authBefore = readFileSync(f.manager.context.authPath);
    const vaultBefore = readFileSync(f.manager.context.vaultPath);
    let caught: unknown;
    try { await f.manager.recover(true, true); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("RECOVERY_REQUIRED");
    expect(readFileSync(f.manager.context.authPath)).toEqual(authBefore);
    expect(readFileSync(f.manager.context.vaultPath)).toEqual(vaultBefore);
    expect(existsSync(f.manager.context.journalPath)).toBe(false);
    expect(existsSync(f.manager.context.recoveryBlockPath)).toBe(true);
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("manual");
    const quarantine = readdirSync(f.manager.context.rootDir).filter(name => name.includes(".journal.quarantine-"));
    expect(quarantine).toHaveLength(1);
    expect(readFileSync(join(f.manager.context.rootDir, quarantine[0]!), "utf8")).toBe(malformed);
    writeFileSync(f.manager.context.authPath, f.source);
    expect(await f.manager.recover(false)).toMatchObject({
      recovered: true,
      action: "confirm-current-owner",
    });
    expect(existsSync(f.manager.context.recoveryBlockPath)).toBe(false);
    expect(probeNativeProfileRecoveryState(f.manager.context)).toBe("none");
  });

  test("automatic recovery reports an externally refreshed target", async () => {
    const f = await enrolledFixture();
    await leavePendingJournal(f);
    const refreshed = envelope("account-target", "target-refreshed-auto");
    writeFileSync(f.manager.context.authPath, refreshed);
    expect(await f.manager.recover(false)).toMatchObject({
      recovered: true,
      action: "commit-target",
      externallyRefreshed: true,
      restartRequired: true,
    });
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(refreshed);
  });

  test("preserves exact auth bytes, encrypts inactive profiles, and leaves task/history files untouched", async () => {
    const f = await enrolledFixture();
    const taskPath = join(f.codexHome, "sessions", "task.jsonl");
    const historyPath = join(f.codexHome, "history.jsonl");
    mkdirSync(dirname(taskPath), { recursive: true });
    writeFileSync(taskPath, "task-history\n");
    writeFileSync(historyPath, "local-history\n");

    const vaultText = readFileSync(f.manager.context.vaultPath, "utf8");
    expect(vaultText).not.toContain("opaque-access-target");
    expect(vaultText).not.toContain("opaque-refresh-target");
    expect(vaultText).not.toContain("account-target");
    expect(() => readFileSync(join(f.stage.stagingCodexHome, "auth.json"))).toThrow();

    const switched = await f.manager.switch("work", true);
    expect(switched.restartRequired).toBe(true);
    expect(readFileSync(join(f.codexHome, "auth.json"), "utf8")).toBe(f.target);
    expect(readFileSync(taskPath, "utf8")).toBe("task-history\n");
    expect(readFileSync(historyPath, "utf8")).toBe("local-history\n");

    await f.manager.switch("personal", true);
    expect(readFileSync(join(f.codexHome, "auth.json"), "utf8")).toBe(f.source);
    expect(f.transitions).toEqual([
      "account-source->account-target",
      "account-target->account-source",
    ]);
  });

  test("a read-back mismatch restores the exact source and removes the journal", async () => {
    const f = await enrolledFixture();
    const authPath = f.manager.context.authPath;
    let authWrites = 0;
    const failing = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === authPath && authWrites++ === 0) return atomic(path, "{}\n");
        return atomic(path, content);
      },
    });
    let caught: unknown;
    try { await failing.switch("work", true); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("SWITCH_ROLLED_BACK");
    expect(readFileSync(join(f.codexHome, "auth.json"), "utf8")).toBe(f.source);
    expect((await failing.doctor()).recoveryPending).toBe(false);
    expect((await failing.list()).activeProfileId).toBe(f.sourceProfile.id);
  });

  test("rollback verification failure retains the encrypted recovery journal and never claims success", async () => {
    const f = await enrolledFixture();
    const authPath = f.manager.context.authPath;
    let authWrites = 0;
    const failing = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === authPath) {
          authWrites += 1;
          if (authWrites <= 2) return atomic(path, "{}\n");
        }
        return atomic(path, content);
      },
    });
    let caught: unknown;
    try { await failing.switch("work", true); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("AUTH_RESTORE_FAILED");
    expect((await failing.doctor()).recoveryPending).toBe(true);
    const journal = readFileSync(failing.context.journalPath, "utf8");
    expect(journal).not.toContain("opaque-refresh-source");
    expect(journal).not.toContain("opaque-refresh-target");
  });

  test("normal switch rejects a busy native Codex process before any durable write", async () => {
    const f = await enrolledFixture();
    const blocked = new NativeProfileManager({
      ...f.options,
      processProbe: async () => ({ status: "busy" as const, count: 2 }),
    });
    let caught: unknown;
    try { await blocked.switch("work", true); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("CODEX_BUSY");
    expect(readFileSync(blocked.context.authPath, "utf8")).toBe(f.source);
    expect(existsSync(blocked.context.journalPath)).toBe(false);
    expect((await blocked.list()).activeProfileId).toBe(f.sourceProfile.id);
  });

  test("vault-write failure after auth replacement restores exact source and removes the journal", async () => {
    const f = await enrolledFixture();
    let vaultWrites = 0;
    const failing = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === f.manager.context.vaultPath && vaultWrites++ === 0) throw new Error("injected switch vault failure");
        return atomic(path, content);
      },
    });
    let caught: unknown;
    try { await failing.switch("work", true); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("SWITCH_ROLLED_BACK");
    expect(readFileSync(failing.context.authPath, "utf8")).toBe(f.source);
    expect(existsSync(failing.context.journalPath)).toBe(false);
    expect((await failing.list()).activeProfileId).toBe(f.sourceProfile.id);
  });

  test("explicit rollback recovery applies the native Codex process guard", async () => {
    const f = await enrolledFixture();
    const authPath = f.manager.context.authPath;
    const journalPath = f.manager.context.journalPath;
    let authWrites = 0;
    const interrupted = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === authPath) {
          authWrites += 1;
          if (authWrites > 1) throw new Error("injected restore failure");
        }
        if (path === journalPath && hasJournalPhase(content, "auth-replaced")) {
          throw new Error("injected post-replacement failure");
        }
        return atomic(path, content);
      },
    });
    let switchError: unknown;
    try { await interrupted.switch("work", true); } catch (error) { switchError = error; }
    expect(switchError).toBeInstanceOf(NativeProfileError);
    expect((switchError as NativeProfileError).code).toBe("AUTH_RESTORE_FAILED");
    expect(readFileSync(authPath, "utf8")).toBe(f.target);

    const blocked = new NativeProfileManager({
      ...f.options,
      processProbe: async () => ({ status: "busy" as const, count: 1 }),
    });
    let recoveryError: unknown;
    try { await blocked.recover(true, true); } catch (error) { recoveryError = error; }

    expect(recoveryError).toBeInstanceOf(NativeProfileError);
    expect((recoveryError as NativeProfileError).code).toBe("CODEX_BUSY");
    expect(readFileSync(authPath, "utf8")).toBe(f.target);
    expect(existsSync(journalPath)).toBe(true);
  });

  test("pending recovery blocks register before auth or vault mutation", async () => {
    const f = await enrolledFixture();
    await leavePendingJournal(f);
    const authBefore = readFileSync(f.manager.context.authPath, "utf8");
    const vaultBefore = readFileSync(f.manager.context.vaultPath, "utf8");
    const journalBefore = readFileSync(f.manager.context.journalPath, "utf8");

    let caught: unknown;
    try { await f.manager.register("renamed"); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("RECOVERY_REQUIRED");
    expect((caught as NativeProfileError).message).toContain("ocx account main recover");
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(authBefore);
    expect(readFileSync(f.manager.context.vaultPath, "utf8")).toBe(vaultBefore);
    expect(readFileSync(f.manager.context.journalPath, "utf8")).toBe(journalBefore);
  });

  test("pending recovery blocks prepareStage before creating staging plaintext", async () => {
    const f = await enrolledFixture();
    await leavePendingJournal(f);
    const authBefore = readFileSync(f.manager.context.authPath, "utf8");
    const vaultBefore = readFileSync(f.manager.context.vaultPath, "utf8");
    const journalBefore = readFileSync(f.manager.context.journalPath, "utf8");
    const stagingBefore = readdirSync(f.manager.context.stagingRoot);

    let caught: unknown;
    try { await f.manager.prepareStage(); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("RECOVERY_REQUIRED");
    expect(readdirSync(f.manager.context.stagingRoot)).toEqual(stagingBefore);
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(authBefore);
    expect(readFileSync(f.manager.context.vaultPath, "utf8")).toBe(vaultBefore);
    expect(readFileSync(f.manager.context.journalPath, "utf8")).toBe(journalBefore);
  });

  test("pending recovery blocks finishStage without deleting staged plaintext", async () => {
    const f = await enrolledFixture();
    const stage = await f.manager.prepareStage();
    const stagedEnvelope = envelope("account-third", "third");
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), stagedEnvelope);
    await leavePendingJournal(f);
    const authBefore = readFileSync(f.manager.context.authPath, "utf8");
    const vaultBefore = readFileSync(f.manager.context.vaultPath, "utf8");
    const journalBefore = readFileSync(f.manager.context.journalPath, "utf8");

    let caught: unknown;
    try { await f.manager.finishStage(stage.stageId, "third"); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("RECOVERY_REQUIRED");
    expect(readFileSync(join(stage.stagingCodexHome, "auth.json"), "utf8")).toBe(stagedEnvelope);
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(authBefore);
    expect(readFileSync(f.manager.context.vaultPath, "utf8")).toBe(vaultBefore);
    expect(readFileSync(f.manager.context.journalPath, "utf8")).toBe(journalBefore);
  });

  test("explicit rollback preserves a digest-changed target envelope before restoring source auth", async () => {
    const f = await enrolledFixture();
    await leavePendingJournal(f);
    const refreshedTarget = envelope("account-target", "target-refreshed");
    writeFileSync(f.manager.context.authPath, refreshedTarget);

    const result = await f.manager.recover(true, true);

    expect(result).toMatchObject({ recovered: true, action: "rollback-source", restartRequired: true });
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(f.source);
    expect(existsSync(f.manager.context.journalPath)).toBe(false);
    const vaultText = readFileSync(f.manager.context.vaultPath, "utf8");
    expect(vaultText).not.toContain("target-refreshed");
    expect(vaultText).not.toContain("opaque-access-target-refreshed");
    expect(vaultText).not.toContain("opaque-refresh-target-refreshed");
    const vault = readNativeProfileVault(f.manager.context)!;
    expect(vault.activeProfileId).toBe(f.sourceProfile.id);
    const targetProfile = vault.profiles.find(profile => profile.id === f.targetProfile.id)!;
    expect(targetProfile.state).toBe("inactive");
    const key = await f.keyProvider.get(f.manager.context.homeId);
    expect(key).not.toBeNull();
    const decrypted = decryptNativeEnvelope(
      f.manager.context,
      targetProfile.id,
      targetProfile.identityHash,
      targetProfile.payload!,
      key!,
    );
    try { expect(decrypted.text).toBe(refreshedTarget); } finally { decrypted.raw.fill(0); key!.key.fill(0); }
    expect(f.transitions).toEqual(["account-target->account-source"]);
  });

  test("rollback preservation failure leaves refreshed target auth untouched and journaled", async () => {
    const f = await enrolledFixture();
    await leavePendingJournal(f);
    const refreshedTarget = envelope("account-target", "target-refreshed-failure");
    writeFileSync(f.manager.context.authPath, refreshedTarget);
    const vaultBefore = readFileSync(f.manager.context.vaultPath, "utf8");
    const failing = new NativeProfileManager({
      ...f.options,
      atomicWrite: async (path, content) => {
        if (path === f.manager.context.vaultPath) throw new Error("injected rollback vault failure");
        return atomic(path, content);
      },
    });

    let caught: unknown;
    try { await failing.recover(true, true); } catch (error) { caught = error; }

    expect(caught).toBeInstanceOf(Error);
    expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(refreshedTarget);
    expect(readFileSync(f.manager.context.vaultPath, "utf8")).toBe(vaultBefore);
    expect(existsSync(f.manager.context.journalPath)).toBe(true);
    const journalText = readFileSync(f.manager.context.journalPath, "utf8");
    expect(journalText).not.toContain("target-refreshed-failure");
    expect(journalText).not.toContain("opaque-refresh-target-refreshed-failure");
  });

  test("non-file Codex credential stores fail before vault or auth mutation", async () => {
    const f = fixture();
    writeFileSync(join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
    const manager = new NativeProfileManager(f.options);
    let caught: unknown;
    try { await manager.register("personal"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
    expect((caught as NativeProfileError).code).toBe("UNSUPPORTED_AUTH_STORE");
    expect(readFileSync(join(f.codexHome, "auth.json"), "utf8")).toBe(f.source);
    expect(() => readFileSync(manager.context.vaultPath)).toThrow();
  });
});
