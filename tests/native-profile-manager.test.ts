import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NativeProfileManager } from "../src/codex/native-profile-manager";
import { decryptNativeEnvelope, readNativeProfileVault } from "../src/codex/native-profile-store";
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
      if (path === journalPath && content.includes('"phase": "auth-replaced"')) {
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
  crash = false,
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-lock-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NATIVE_PROFILE_TEST_CODEX_HOME: f.codexHome,
      NATIVE_PROFILE_TEST_CONFIG_DIR: f.configDir,
      NATIVE_PROFILE_TEST_READY: readyPath,
      NATIVE_PROFILE_TEST_RELEASE: releasePath,
      NATIVE_PROFILE_TEST_CRASH: crash ? "1" : "0",
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
    const child = spawnLockHolder(f, readyPath, join(f.root, "unused-release"), true);
    await waitForPath(readyPath);
    expect(await child.exited).toBe(0);

    const successor = new NativeProfileManager({ ...f.options, lockWaitMs: 250 });
    expect((await successor.recover(false)).recovered).toBe(false);
  }, 15_000);

  test("two processes exclude each other and predecessor release cannot delete a successor lock", async () => {
    const f = fixture();
    const firstReady = join(f.root, "first-ready");
    const firstRelease = join(f.root, "first-release");
    const secondReady = join(f.root, "second-ready");
    const secondRelease = join(f.root, "second-release");
    const first = spawnLockHolder(f, firstReady, firstRelease);
    let second: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await waitForPath(firstReady);
      second = spawnLockHolder(f, secondReady, secondRelease);
      await Bun.sleep(150);
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

  test("finish removes staging after auth validation failure", async () => {
    const f = fixture();
    const manager = new NativeProfileManager(f.options);
    await manager.register("personal");
    const stage = await manager.prepareStage();
    writeFileSync(join(stage.stagingCodexHome, "auth.json"), "{}\n");

    let caught: unknown;
    try { await manager.finishStage(stage.stageId, "invalid"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeProfileError);
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
    expect(existsSync(stage.stagingCodexHome)).toBe(true);
    await manager.cancelStage(stage.stageId);
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
        if (path === journalPath && content.includes('"phase": "auth-replaced"')) {
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
