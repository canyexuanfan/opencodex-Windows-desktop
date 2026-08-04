import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

const repoRoot = resolve(import.meta.dir, "..");
const sandboxes: Sandbox[] = [];

interface Sandbox {
  readonly root: string;
  readonly codexHome: string;
  readonly opencodexHome: string;
  readonly env: Record<string, string>;
}

function nativeEntry(slug: string, visibility = "list"): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    description: "native",
    priority: 9,
    visibility,
    supported_in_api: true,
    shell_type: "shell_command",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
  };
}

function catalogBytes(visibility = "list", routed = false): string {
  return `${JSON.stringify({
    retained_marker: visibility,
    models: [
      nativeEntry("gpt-5.5", visibility),
      ...(routed ? [{
        ...nativeEntry("vendor/old-model"),
        description: "Routed via opencodex → vendor.",
      }] : []),
    ],
  }, null, 2)}\n`;
}

function makeSandbox(prefix: string): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const codexHome = join(root, "codex-home");
  const opencodexHome = join(root, "opencodex-home");
  const home = join(root, "user-home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, opencodexHome, home, runtime]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }
  const sandbox = {
    root,
    codexHome,
    opencodexHome,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: runtime,
      TEMP: runtime,
      TMP: runtime,
      XDG_RUNTIME_DIR: runtime,
      LOCALAPPDATA: join(home, "LocalAppData"),
    },
  };
  sandboxes.push(sandbox);
  return sandbox;
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

async function runChild(
  sandbox: Sandbox,
  script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function holdCatalogLock(sandbox: Sandbox): Promise<{
  release(): void;
  child: ReturnType<typeof Bun.spawn>;
}> {
  const ready = join(sandbox.root, "lock-ready");
  const release = join(sandbox.root, "lock-release");
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { withCatalogWriteSerialization } from "./src/codex/catalog-write-serialization.ts";
    const home = process.env.CODEX_HOME;
    const outcome = withCatalogWriteSerialization(home, () => {
      writeFileSync(${JSON.stringify(ready)}, "ready");
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(${JSON.stringify(release)})) Atomics.wait(waiter, 0, 0, 10);
    });
    if (outcome.kind !== "completed") throw new Error(JSON.stringify(outcome));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForPath(ready);
  return { release: () => writeFileSync(release, "release"), child };
}

function seedCatalog(sandbox: Sandbox, bytes = catalogBytes()): string {
  const path = join(sandbox.codexHome, "catalog.json");
  writeFileSync(join(sandbox.codexHome, "config.toml"), 'model_catalog_json = "catalog.json"\n');
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  const identity = resolveEffectiveUserIdentity();
  for (const sandbox of sandboxes.splice(0)) {
    const database = resolveCodexCatalogSerializationDatabasePath(identity, sandbox.codexHome);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("startup and CLI sync-cache cannot write models_cache while another process owns K", async () => {
  const sandbox = makeSandbox("ocx-retained-cache-");
  seedCatalog(sandbox);
  const cachePath = join(sandbox.codexHome, "models_cache.json");
  const holder = await holdCatalogLock(sandbox);
  try {
    const startupProbe = await runChild(sandbox, `
      const sentinel = new Error("TEST_LISTENER_INTERCEPTED");
      Bun.serve = () => { throw sentinel; };
      const { startServer } = await import("./src/server/index.ts");
      try {
        startServer(0);
        throw new Error("startServer unexpectedly reached a listener");
      } catch (error) {
        if (error !== sentinel) throw error;
      }
    `);
    expect(startupProbe.exitCode).toBe(0);
    expect(existsSync(cachePath)).toBe(false);

    const cli = Bun.spawnSync([process.execPath, "run", "src/cli/index.ts", "sync-cache"], {
      cwd: repoRoot,
      env: sandbox.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
    const cliSource = readFileSync(join(repoRoot, "src/cli/index.ts"), "utf8");
    const cliStart = cliSource.indexOf('case "sync-cache"');
    const cliRoot = cliSource.slice(cliStart, cliSource.indexOf('case "gui"', cliStart));
    expect(cliRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(cliRoot).toContain("invalidateCodexModelsCacheWithPermit");

    const startup = readFileSync(join(repoRoot, "src/server/index.ts"), "utf8");
    const startupStart = startup.indexOf("const startupCodexHome");
    const startupRoot = startup.slice(startupStart, startup.indexOf("armClaudeCodeBaseline", startupStart));
    expect(startupRoot).toContain("withCatalogWriteSerialization(startupCodexHome");
    expect(startupRoot).toContain("invalidateCodexModelsCacheWithPermit");
  } finally {
    holder.release();
    expect(await holder.child.exited).toBe(0);
  }
});

test("native restore cannot read-transform-write the catalog while another process owns K", async () => {
  const sandbox = makeSandbox("ocx-retained-restore-");
  const catalogPath = seedCatalog(sandbox, catalogBytes("list", true));
  writeFileSync(join(sandbox.opencodexHome, "catalog-backup.json"), catalogBytes("list", false));
  const before = readFileSync(catalogPath, "utf8");
  const holder = await holdCatalogLock(sandbox);
  try {
    const restored = await runChild(sandbox, `
      const { restoreNativeCodex } = await import("./src/codex/inject.ts");
      console.log(JSON.stringify(restoreNativeCodex()));
    `);
    expect(restored.exitCode).toBe(0);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
    const source = readFileSync(join(repoRoot, "src/codex/inject.ts"), "utf8");
    const restoreRoot = source.slice(source.indexOf("const owningCodexHome"), source.indexOf("// Design B", source.indexOf("const owningCodexHome")));
    expect(restoreRoot).toContain("withCatalogWriteSerialization(owningCodexHome");
    expect(restoreRoot).toContain("restoreCodexCatalogWithPermit");
  } finally {
    holder.release();
    expect(await holder.child.exited).toBe(0);
  }
});

async function runPublisher(
  sandbox: Sandbox,
  kind: "convergence" | "retained",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const config = { port: 10100, defaultProvider: "openai", providers: {}, disabledModels: ["gpt-5.5"] };
  if (kind === "retained") {
    return runChild(sandbox, `
      const { handleManagementAPI } = await import("./src/server/management-api.ts");
      const config = ${JSON.stringify(config)};
      const req = new Request("http://localhost/api/sync", { method: "POST", headers: { Host: "localhost" } });
      const response = await handleManagementAPI(req, new URL(req.url), config);
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `);
  }
  return runChild(sandbox, `
    const { withConfigMutationLockSync } = await import("./src/config.ts");
    const { captureCatalogAdmissionSnapshot, createCatalogConvergeRequest } = await import("./src/codex/catalog-admission.ts");
    const { convergeCodexCatalog } = await import("./src/codex/convergence.ts");
    const config = ${JSON.stringify(config)};
    withConfigMutationLockSync(() => undefined);
    const snapshot = captureCatalogAdmissionSnapshot(config);
    const result = await convergeCodexCatalog(snapshot, createCatalogConvergeRequest({ deadlineMs: 2000 }));
    console.log(JSON.stringify(result));
  `);
}

for (const publisher of ["convergence", "retained"] as const) {
  test(`POST /api/sync gathered first and acquired K second does not clobber a newer ${publisher} catalog`, async () => {
    const sandbox = makeSandbox(`ocx-retained-race-${publisher}-`);
    const catalogPath = seedCatalog(sandbox);
    const initial = readFileSync(catalogPath, "utf8");
    const requested = join(sandbox.root, "provider-requested");
    const release = join(sandbox.root, "provider-release");
    const config = {
      port: 10100,
      defaultProvider: "together",
      providers: {
        together: {
          adapter: "openai-chat",
          baseUrl: "https://api.together.xyz/v1",
          apiKey: "race-key",
          models: ["fallback-model"],
        },
      },
    };
    const sync = Bun.spawn([process.execPath, "--eval", `
      import { existsSync, writeFileSync } from "node:fs";
      const config = ${JSON.stringify(config)};
      config.providers.together.fetch = async () => {
        writeFileSync(${JSON.stringify(requested)}, "requested");
        while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
        return Response.json({ data: [{ id: "race-model" }] });
      };
      const { handleManagementAPI } = await import("./src/server/management-api.ts");
      const req = new Request("http://localhost/api/sync", { method: "POST", headers: { Host: "localhost" } });
      const response = await handleManagementAPI(req, new URL(req.url), config);
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
    `], { cwd: repoRoot, env: sandbox.env, stdout: "pipe", stderr: "pipe" });

    await Promise.race([
      waitForPath(requested),
      sync.exited.then(async exitCode => {
        const stdout = await new Response(sync.stdout).text();
        const stderr = await new Response(sync.stderr).text();
        throw new Error(`sync exited before provider barrier (${exitCode})\nstdout=${stdout}\nstderr=${stderr}`);
      }),
    ]);
    const published = await runPublisher(sandbox, publisher);
    if (published.exitCode !== 0) {
      throw new Error(`${publisher} publisher failed\nstdout=${published.stdout}\nstderr=${published.stderr}`);
    }
    const newer = readFileSync(catalogPath, "utf8");
    expect(newer).not.toBe(initial);

    writeFileSync(release, "release");
    const [exitCode, stdout, stderr] = await Promise.all([
      sync.exited,
      new Response(sync.stdout).text(),
      new Response(sync.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
    expect(readFileSync(catalogPath, "utf8")).toBe(newer);
  }, 20_000);
}
