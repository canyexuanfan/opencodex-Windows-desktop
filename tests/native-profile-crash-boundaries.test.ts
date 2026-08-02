import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { NativeProfileManager, type NativeProfileSwitchBoundary } from "../src/codex/native-profile-manager";
import { readNativeProfileJournal, readNativeProfileVault } from "../src/codex/native-profile-store";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../src/codex/native-profile-types";
import type { OcxConfig } from "../src/types";

const roots: string[] = [];
const oldOcx = process.env.OPENCODEX_HOME;
const oldCodex = process.env.CODEX_HOME;

function restoreEnv(name: "OPENCODEX_HOME" | "CODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("OPENCODEX_HOME", oldOcx);
  restoreEnv("CODEX_HOME", oldCodex);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  constructor(private readonly bytes: Buffer) {}
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:switch-test", key: Buffer.from(this.bytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:switch-test", key: Buffer.from(this.bytes) }; }
}

function envelope(accountId: string, marker: string): string {
  return ` {\n  "auth_mode": "chatgpt",\n  "tokens": {\n    "id_token": "opaque-id-${marker}",\n    "access_token": "opaque-access-${marker}",\n    "refresh_token": "opaque-refresh-${marker}",\n    "account_id": "${accountId}"\n  }\n}\n`;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-crash-"));
  roots.push(root);
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const configDir = join(home, ".opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  const source = envelope("account-source", "source");
  const target = envelope("account-target", "target");
  writeFileSync(join(codexHome, "auth.json"), source);
  const key = Buffer.alloc(32, 0x33);
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider: new MemoryKeyProvider(key),
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
  });
  const sourceProfile = (await manager.register("source")).profile;
  const stage = await manager.prepareStage();
  writeFileSync(join(stage.stagingCodexHome, "auth.json"), target);
  const targetProfile = (await manager.finishStage(stage.stageId, "target")).profile;
  const initialRevision = readNativeProfileVault(manager.context)!.revision;

  process.env.OPENCODEX_HOME = configDir;
  process.env.CODEX_HOME = codexHome;
  saveConfig({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } },
    codexAccounts: [],
    activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
  } as OcxConfig);
  restoreEnv("OPENCODEX_HOME", oldOcx);
  restoreEnv("CODEX_HOME", oldCodex);
  return { root, home, codexHome, configDir, source, target, key, manager, sourceProfile, targetProfile, initialRevision };
}

async function waitFor(path: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

function spawnSwitch(f: Awaited<ReturnType<typeof fixture>>, options: { boundary?: NativeProfileSwitchBoundary; marker?: string; release?: string; contention?: string; result: string }) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-switch-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: f.home,
      USERPROFILE: f.home,
      CODEX_HOME: f.codexHome,
      OPENCODEX_HOME: f.configDir,
      NATIVE_SWITCH_CODEX_HOME: f.codexHome,
      NATIVE_SWITCH_CONFIG_DIR: f.configDir,
      NATIVE_SWITCH_KEY: f.key.toString("base64"),
      NATIVE_SWITCH_RESULT: options.result,
      ...(options.boundary ? { NATIVE_SWITCH_CRASH_BOUNDARY: options.boundary } : {}),
      ...(options.marker ? { NATIVE_SWITCH_MARKER: options.marker } : {}),
      ...(options.release ? { NATIVE_SWITCH_RELEASE: options.release } : {}),
      ...(options.contention ? { NATIVE_SWITCH_CONTENTION: options.contention } : {}),
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

function startupPaths(f: Awaited<ReturnType<typeof fixture>>) {
  return { port: join(f.root, "port"), release: join(f.root, "recover"), settled: join(f.root, "settled"), upstream: join(f.root, "upstream"), stop: join(f.root, "stop") };
}

function spawnStartup(f: Awaited<ReturnType<typeof fixture>>, p: ReturnType<typeof startupPaths>) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-startup-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_HOME: f.codexHome, OPENCODEX_HOME: f.configDir,
      OPENCODEX_ADMIN_AUTH_TOKEN: "crash-test-admin",
      NATIVE_STARTUP_CODEX_HOME: f.codexHome, NATIVE_STARTUP_CONFIG_DIR: f.configDir,
      NATIVE_STARTUP_KEY: f.key.toString("base64"), NATIVE_STARTUP_KEY_REF: "memory:switch-test", NATIVE_STARTUP_PORT: p.port,
      NATIVE_STARTUP_RECOVERY_RELEASE: p.release, NATIVE_STARTUP_SETTLED: p.settled,
      NATIVE_STARTUP_UPSTREAM: p.upstream, NATIVE_STARTUP_STOP: p.stop,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}

async function mainRequest(port: number) {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.6-sol", input: "crash recovery", stream: false }) });
}

const boundaries: Array<{
  boundary: NativeProfileSwitchBoundary;
  auth: "source" | "target";
  owner: "source" | "target";
  phase: "prepared" | "auth-replaced" | "vault-committed" | null;
}> = [
  { boundary: "journal-prepared", auth: "source", owner: "source", phase: "prepared" },
  { boundary: "auth-replaced", auth: "target", owner: "source", phase: "prepared" },
  { boundary: "vault-committed", auth: "target", owner: "target", phase: "auth-replaced" },
  { boundary: "runtime-transition-published", auth: "target", owner: "target", phase: "vault-committed" },
  { boundary: "journal-deleted", auth: "target", owner: "target", phase: null },
];

describe("native profile subprocess crash boundaries", () => {
  test("hard process exit at every durable boundary converges exact auth, vault, journal, gate, and runtime bearer", async () => {
    for (const scenario of boundaries) {
      const f = await fixture();
      const marker = join(f.root, `crash-${scenario.boundary}`);
      const result = join(f.root, `result-${scenario.boundary}`);
      const child = spawnSwitch(f, { boundary: scenario.boundary, marker, result });
      await Promise.race([
        waitFor(marker),
        child.exited.then(async exit => {
          if (existsSync(marker)) return;
          const detail = existsSync(result) ? readFileSync(result, "utf8") : await new Response(child.stderr).text();
          throw new Error(`${scenario.boundary} child exited ${exit} before marker: ${detail}`);
        }),
      ]);
      expect(await child.exited).toBe(86);
      expect(existsSync(result)).toBe(false);

      expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(scenario.auth === "source" ? f.source : f.target);
      const vault = readNativeProfileVault(f.manager.context)!;
      expect(vault.activeProfileId).toBe(scenario.owner === "source" ? f.sourceProfile.id : f.targetProfile.id);
      expect(vault.revision).toBe(f.initialRevision + (scenario.owner === "target" ? 1 : 0));
      const rawVault = readFileSync(f.manager.context.vaultPath, "utf8");
      expect(rawVault).not.toContain("opaque-access");
      expect(rawVault).not.toContain("opaque-refresh");
      const journal = readNativeProfileJournal(f.manager.context);
      expect(journal?.phase ?? null).toBe(scenario.phase);

      const p = startupPaths(f);
      const restart = spawnStartup(f, p);
      try {
        await waitFor(p.port);
        const port = Number(readFileSync(p.port, "utf8"));
        if (scenario.phase) {
          expect((await mainRequest(port)).status).toBeGreaterThanOrEqual(400);
          expect(existsSync(p.upstream)).toBe(false);
          writeFileSync(p.release, "recover");
        }
        await waitFor(p.settled);
        expect(JSON.parse(readFileSync(p.settled, "utf8"))).toMatchObject({ gate: { status: "ready" } });
        expect((await mainRequest(port)).status).toBe(200);
        await waitFor(p.upstream);
        const receipt = JSON.parse(readFileSync(p.upstream, "utf8").trim().split("\n").at(-1)!);
        const finalTarget = scenario.boundary !== "journal-prepared";
        expect(receipt.authorization).toBe(`Bearer opaque-access-${finalTarget ? "target" : "source"}`);
        expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(finalTarget ? f.target : f.source);
        const recoveredVault = readNativeProfileVault(f.manager.context)!;
        expect(recoveredVault.activeProfileId).toBe(finalTarget ? f.targetProfile.id : f.sourceProfile.id);
        expect(recoveredVault.revision).toBe(f.initialRevision + (finalTarget ? 1 : 0));
        expect(readNativeProfileJournal(f.manager.context)).toBeNull();
      } finally {
        writeFileSync(p.release, "recover");
        writeFileSync(p.stop, "stop");
        expect(await restart.exited).toBe(0);
      }
    }
  }, 90_000);

  test("two concurrent real switches serialize to one commit without credential overlap", async () => {
    const f = await fixture();
    const firstReady = join(f.root, "first-ready");
    const firstRelease = join(f.root, "first-release");
    const firstResult = join(f.root, "first-result");
    const secondResult = join(f.root, "second-result");
    const secondContention = join(f.root, "second-contention");
    const first = spawnSwitch(f, { marker: firstReady, release: firstRelease, result: firstResult });
    let second: ReturnType<typeof spawnSwitch> | undefined;
    try {
      await waitFor(firstReady);
      second = spawnSwitch(f, { contention: secondContention, result: secondResult });
      await waitFor(secondContention);
      expect(existsSync(secondResult)).toBe(false);
      writeFileSync(firstRelease, "release");
      expect(await first.exited).toBe(0);
      expect(await second.exited).toBe(0);
      const results = [JSON.parse(readFileSync(firstResult, "utf8")), JSON.parse(readFileSync(secondResult, "utf8"))];
      if (results.filter(item => item.ok).length !== 1) throw new Error(`unexpected concurrent results: ${JSON.stringify(results)}`);
      expect(results.filter(item => !item.ok).map(item => item.code)).toEqual(["INVALID_REQUEST"]);
      expect(readFileSync(f.manager.context.authPath, "utf8")).toBe(f.target);
      expect(readNativeProfileVault(f.manager.context)!.activeProfileId).toBe(f.targetProfile.id);
      expect(readNativeProfileJournal(f.manager.context)).toBeNull();
    } finally {
      try { writeFileSync(firstRelease, "release"); } catch { /* fixture cleanup */ }
      if (first.exitCode === null) first.kill();
      if (second?.exitCode === null) second.kill();
      await first.exited;
      if (second) await second.exited;
    }
  }, 20_000);
});
