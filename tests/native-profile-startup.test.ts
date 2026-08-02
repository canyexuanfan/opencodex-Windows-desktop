import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveConfig } from "../src/config";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { NativeProfileManager } from "../src/codex/native-profile-manager";
import {
  encryptNativeEnvelope,
  readNativeEnvelope,
  readNativeProfileVault,
  serializeNativeProfileMetadata,
} from "../src/codex/native-profile-store";
import type {
  NativeProfileKey,
  NativeProfileKeyProvider,
  NativeProfileSwitchJournalV1,
} from "../src/codex/native-profile-types";
import type { OcxConfig } from "../src/types";
import {
  initializeNativeMainStartupGate,
  inspectNativeMainRecoveryJournal,
  nativeMainStartupGateSnapshot,
} from "../src/codex/native-profile-startup";

const roots: string[] = [];
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;

function restoreEnv(name: "OPENCODEX_HOME" | "CODEX_HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnv("CODEX_HOME", previousCodexHome);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class MemoryKeyProvider implements NativeProfileKeyProvider {
  constructor(private readonly bytes: Buffer) {}
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:startup-test", key: Buffer.from(this.bytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:startup-test", key: Buffer.from(this.bytes) }; }
}

function envelope(accountId: string, marker: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `id-${marker}`,
      access_token: `access-${marker}`,
      refresh_token: `refresh-${marker}`,
      account_id: accountId,
    },
  }, null, 2) + "\n";
}

type Phase = "prepared" | "auth-replaced" | "vault-committed";
type Observation = "source-exact" | "source-changed" | "target-exact" | "target-changed" | "unreadable" | "third";

interface Fixture {
  root: string;
  codexHome: string;
  configDir: string;
  key: Buffer;
  manager: NativeProfileManager;
  target: string;
  sourceProfileId: string;
  targetProfileId: string;
}

async function fixture(phase: Phase, observation: Observation, activePool = false): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-startup-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  const source = envelope("account-source", "source");
  const target = envelope("account-target", "target");
  writeFileSync(join(codexHome, "auth.json"), source);
  const key = Buffer.alloc(32, 0x5a);
  const keyProvider = new MemoryKeyProvider(key);
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider,
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
  });
  const registered = await manager.register("source");
  const stage = await manager.prepareStage();
  writeFileSync(join(stage.stagingCodexHome, "auth.json"), target);
  const added = await manager.finishStage(stage.stageId, "target");

  const beforeVault = readNativeProfileVault(manager.context)!;
  const sourceRecord = beforeVault.profiles.find(profile => profile.id === registered.profile.id)!;
  const targetRecord = beforeVault.profiles.find(profile => profile.id === added.profile.id)!;
  const sourceEnvelope = readNativeEnvelope(manager.context.authPath);
  const sourcePayload = encryptNativeEnvelope(
    manager.context,
    sourceRecord.id,
    sourceRecord.identityHash,
    sourceEnvelope,
    { keyRef: "memory:startup-test", key: Buffer.from(key) },
  );
  sourceEnvelope.raw.fill(0);
  const afterVault = structuredClone(beforeVault);
  const afterSource = afterVault.profiles.find(profile => profile.id === sourceRecord.id)!;
  const afterTarget = afterVault.profiles.find(profile => profile.id === targetRecord.id)!;
  afterSource.state = "inactive";
  afterSource.payload = sourcePayload;
  afterTarget.state = "active";
  afterTarget.payload = null;
  afterVault.activeProfileId = afterTarget.id;
  afterVault.revision += 1;

  const journal: NativeProfileSwitchJournalV1 = {
    version: 1,
    transactionId: crypto.randomUUID(),
    homeId: manager.context.homeId,
    phase,
    sourceProfileId: sourceRecord.id,
    sourceIdentityHash: sourceRecord.identityHash,
    sourcePayload,
    targetProfileId: targetRecord.id,
    targetIdentityHash: targetRecord.identityHash,
    targetPayload: targetRecord.payload!,
    beforeVault,
    afterVault,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(manager.context.journalPath, serializeNativeProfileMetadata(journal));

  const observed = observation === "source-exact" ? source
    : observation === "source-changed" ? envelope("account-source", "source-changed")
      : observation === "target-exact" ? target
        : observation === "target-changed" ? envelope("account-target", "target-changed")
          : observation === "third" ? envelope("account-third", "third")
            : "{}\n";
  writeFileSync(manager.context.authPath, observed);

  process.env.OPENCODEX_HOME = configDir;
  process.env.CODEX_HOME = codexHome;
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    codexAccounts: activePool ? [{ id: "pool-a", email: "pool@test", isMain: false }] : [],
    activeCodexAccountId: activePool ? "pool-a" : MAIN_CODEX_ACCOUNT_ID,
    autoSwitchThreshold: 0,
  } as OcxConfig;
  saveConfig(config);
  if (activePool) {
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access",
      refreshToken: "pool-refresh",
      expiresAt: Date.now() + 10 * 60_000,
      chatgptAccountId: "pool-account",
    });
  }
  restoreEnv("OPENCODEX_HOME", previousOpencodexHome);
  restoreEnv("CODEX_HOME", previousCodexHome);
  return { root, codexHome, configDir, key, manager, target, sourceProfileId: sourceRecord.id, targetProfileId: targetRecord.id };
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

function childPaths(f: Fixture) {
  return {
    port: join(f.root, "port"),
    release: join(f.root, "recovery-release"),
    settled: join(f.root, "recovery-settled"),
    upstream: join(f.root, "upstream.jsonl"),
    stop: join(f.root, "stop"),
  };
}

function spawnChild(f: Fixture, paths: ReturnType<typeof childPaths>): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "native-profile-startup-child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      OPENCODEX_HOME: f.configDir,
      CODEX_HOME: f.codexHome,
      OPENCODEX_ADMIN_AUTH_TOKEN: "startup-test-admin",
      NATIVE_STARTUP_CODEX_HOME: f.codexHome,
      NATIVE_STARTUP_CONFIG_DIR: f.configDir,
      NATIVE_STARTUP_KEY: f.key.toString("base64"),
      NATIVE_STARTUP_PORT: paths.port,
      NATIVE_STARTUP_RECOVERY_RELEASE: paths.release,
      NATIVE_STARTUP_SETTLED: paths.settled,
      NATIVE_STARTUP_UPSTREAM: paths.upstream,
      NATIVE_STARTUP_STOP: paths.stop,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function stopChild(child: ReturnType<typeof Bun.spawn>, paths: ReturnType<typeof childPaths>): Promise<void> {
  writeFileSync(paths.release, "release");
  writeFileSync(paths.stop, "stop");
  const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (exit === null) {
    child.kill();
    await child.exited;
    throw new Error("startup child did not stop");
  }
  if (exit !== 0) throw new Error(await new Response(child.stderr).text());
}

async function mainRequest(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "startup gate", stream: false }),
  });
}

const recoverable: Array<{ phase: Phase; observation: Observation; active: "source" | "target" }> = [
  ...(["prepared", "auth-replaced", "vault-committed"] as const).flatMap(phase => [
    { phase, observation: "source-exact" as const, active: "source" as const },
    { phase, observation: "source-changed" as const, active: "source" as const },
    { phase, observation: "target-exact" as const, active: "target" as const },
    { phase, observation: "target-changed" as const, active: "target" as const },
  ]),
];

describe("native-main startup journal gate", () => {
  test("sync journal inspection treats only ENOENT as absent and propagates other failures", () => {
    expect(inspectNativeMainRecoveryJournal("missing", () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    })).toBe("absent");
    expect(() => inspectNativeMainRecoveryJournal("denied", () => {
      throw Object.assign(new Error("private path"), { code: "EACCES" });
    })).toThrow();
  });

  test("startup inspection failure closes the main gate without attempting recovery", async () => {
    let recoverCalls = 0;
    const homeId = "home-inspection-failure";
    const gate = await initializeNativeMainStartupGate({
      manager: {
        context: { homeId, journalPath: "denied" },
        recover: async () => { recoverCalls += 1; return {}; },
      } as unknown as NativeProfileManager,
      inspectJournal: () => { throw Object.assign(new Error("private path"), { code: "EACCES" }); },
    });
    expect(gate).toEqual({ status: "blocked", homeId, reason: "manual-recovery" });
    expect(nativeMainStartupGateSnapshot()).toEqual(gate);
    expect(recoverCalls).toBe(0);
  });

  test("fresh processes gate first admission and converge every recoverable phase/observation", async () => {
    for (const scenario of recoverable) {
      const f = await fixture(scenario.phase, scenario.observation);
      const paths = childPaths(f);
      const child = spawnChild(f, paths);
      try {
        await waitForPath(paths.port);
        const port = Number(readFileSync(paths.port, "utf8"));
        const blocked = await mainRequest(port);
        expect(blocked.status).toBeGreaterThanOrEqual(400);
        expect(existsSync(paths.upstream)).toBe(false);

        writeFileSync(paths.release, "release");
        await waitForPath(paths.settled);
        expect(JSON.parse(readFileSync(paths.settled, "utf8"))).toMatchObject({ gate: { status: "ready" } });
        const allowed = await mainRequest(port);
        if (allowed.status !== 200) {
          throw new Error(`${scenario.phase}/${scenario.observation}: ${allowed.status} ${await allowed.text()} settled=${readFileSync(paths.settled, "utf8")}`);
        }
        expect(existsSync(paths.upstream)).toBe(true);
        const active = (await f.manager.list()).activeProfileId;
        expect(active).toBe(scenario.active === "target" ? f.targetProfileId : f.sourceProfileId);
      } finally {
        await stopChild(child, paths);
      }
    }
  }, 120_000);

  test("manual observations keep main closed while health and explicit recovery remain available", async () => {
    for (const observation of ["unreadable", "third"] as const) {
      const f = await fixture("prepared", observation);
      const paths = childPaths(f);
      const child = spawnChild(f, paths);
      try {
        await waitForPath(paths.port);
        const port = Number(readFileSync(paths.port, "utf8"));
        expect((await mainRequest(port)).status).toBeGreaterThanOrEqual(400);
        expect(existsSync(paths.upstream)).toBe(false);
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

        writeFileSync(paths.release, "release");
        await waitForPath(paths.settled);
        expect(JSON.parse(readFileSync(paths.settled, "utf8"))).toMatchObject({ gate: { status: "blocked", reason: "manual-recovery" } });
        expect((await mainRequest(port)).status).toBeGreaterThanOrEqual(400);
        expect(existsSync(paths.upstream)).toBe(false);

        writeFileSync(join(f.codexHome, "auth.json"), f.target);
        const recovered = await fetch(`http://127.0.0.1:${port}/api/native-main-profiles/recover`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencodex-api-key": "startup-test-admin" },
          body: JSON.stringify({ rollback: false }),
        });
        expect(recovered.status).toBe(200);
        expect((await mainRequest(port)).status).toBe(200);
        expect(existsSync(paths.upstream)).toBe(true);
      } finally {
        await stopChild(child, paths);
      }
    }
  }, 45_000);

  test("a pending native-main journal does not block an ordinary Pool account", async () => {
    const f = await fixture("prepared", "unreadable", true);
    const paths = childPaths(f);
    const child = spawnChild(f, paths);
    try {
      await waitForPath(paths.port);
      const port = Number(readFileSync(paths.port, "utf8"));
      expect((await mainRequest(port)).status).toBe(200);
      await waitForPath(paths.upstream);
      const receipt = JSON.parse(readFileSync(paths.upstream, "utf8").trim());
      expect(receipt.authorization).toBe("Bearer pool-access");
    } finally {
      await stopChild(child, paths);
    }
  }, 20_000);
});
