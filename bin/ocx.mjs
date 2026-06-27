#!/usr/bin/env node
/**
 * opencodex npm bin launcher.
 *
 * The package source is TypeScript that runs on the Bun runtime. To let
 * `npm install -g @bitkyc08/opencodex` work without a separately-installed Bun,
 * we bundle the runtime via the `bun` npm dependency and exec it from this
 * Node shim. (Dev still runs `bun run src/cli.ts` directly via the shebang on
 * src/cli.ts — only the published npm `bin` routes through here.)
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@bitkyc08/opencodex";
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli.ts");

function isNodeModulesInstall() {
  return here.split(/[\\/]/).includes("node_modules");
}

function isBunGlobalInstall() {
  return /[\\/]\.bun[\\/]/.test(here);
}

function npmBin() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function currentPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

function updateTag(currentVersion) {
  const tagIndex = process.argv.indexOf("--tag");
  if (tagIndex !== -1 && process.argv[tagIndex + 1]) return process.argv[tagIndex + 1];
  return String(currentVersion).includes("-preview.") ? "preview" : "latest";
}

function configDir() {
  return resolve(process.env.OPENCODEX_HOME?.trim() || join(homedir(), ".opencodex"));
}

function shouldRepairCodexShim() {
  return existsSync(join(configDir(), "codex-shim.json"));
}

function repairCodexShimIfNeeded() {
  if (!shouldRepairCodexShim()) return;
  const launcher = fileURLToPath(import.meta.url);
  const res = spawnSync(process.execPath, [launcher, "codex-shim", "install"], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (res.status !== 0) {
    console.warn(`opencodex: Codex shim repair failed (${res.status ?? "unknown exit"}). Try: ocx codex-shim install`);
  }
}

function runNpmSelfUpdate() {
  const current = currentPackageVersion();
  const tag = updateTag(current);
  const npm = npmBin();
  const latestResult = spawnSync(npm, ["view", `${PKG}@${tag}`, "version"], {
    encoding: "utf8",
    timeout: 12000,
    windowsHide: true,
  });
  const latest = latestResult.status === 0 ? latestResult.stdout.trim() : "";

  console.log(`opencodex v${current} (installed via npm, tag ${tag})`);
  if (latest && latest === current) {
    console.log(`Already on the latest ${tag} version (v${latest}).`);
    process.exit(0);
  }

  console.log(`Updating${latest ? ` to v${latest}` : ""}...\n$ ${npm} install -g ${PKG}@${tag}`);
  const res = spawnSync(npm, ["install", "-g", `${PKG}@${tag}`], {
    stdio: "inherit",
    timeout: 180000,
    windowsHide: true,
  });
  if (res.status === 0) {
    console.log(`\nUpdated${latest ? ` to v${latest}` : ""}.`);
    repairCodexShimIfNeeded();
    console.log("Restart the proxy:  ocx stop && ocx start");
    console.log("If a background service is installed, refresh its baked path:  ocx service install");
    process.exit(0);
  }
  console.error(`\nUpdate failed (${npm} exit ${res.status ?? "?"}). Try manually:  ${npm} install -g ${PKG}@${tag}`);
  process.exit(1);
}

function bunBinDir() {
  // Resolve the `bun` dependency's directory without hardcoding the platform
  // package — npm's os/cpu/libc resolution already picked the right @oven/bun-*.
  return dirname(require.resolve("bun/package.json"));
}

// The `bun` package ships a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary. --ignore-scripts / pnpm leave
// the ~450-byte stub in place, which is NOT executable (ENOEXEC). A size gate
// cleanly distinguishes the stub from a real binary on every platform.
const REAL_BUN_MIN_BYTES = 1_000_000;

function findBunBinary(bunDir) {
  // The npm `bun` package ships the binary as bin/bun.exe on every platform;
  // probe bin/bun too for forward compatibility.
  for (const name of ["bun.exe", "bun"]) {
    const p = join(bunDir, "bin", name);
    if (existsSync(p) && statSync(p).size >= REAL_BUN_MIN_BYTES) return p;
  }
  return null;
}

function fail(msg) {
  console.error(
    `opencodex: ${msg}\n` +
      "The bundled Bun runtime could not be prepared. This usually means the\n" +
      "install skipped lifecycle scripts or optional dependencies. Reinstall with:\n" +
      "  npm install -g @bitkyc08/opencodex\n" +
      "(without --ignore-scripts and without --omit=optional / optional=false)"
  );
  process.exit(1);
}

function resolveBun() {
  let bunDir;
  try {
    bunDir = bunBinDir();
  } catch {
    fail("the `bun` dependency is not installed.");
  }

  let bin = findBunBinary(bunDir);
  if (bin) return bin;

  // Lazy fallback: --ignore-scripts (or a failed postinstall) leaves the
  // ~450-byte placeholder stub. Run the bun package's own installer once.
  const installJs = join(bunDir, "install.js");
  if (existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (!bin) fail("Bun binary missing after install attempt.");
  return bin;
}

if (process.argv[2] === "update" && isNodeModulesInstall() && !isBunGlobalInstall()) {
  runNpmSelfUpdate();
}

const bun = resolveBun();
const res = spawnSync(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.error) {
  console.error(`opencodex: failed to launch Bun runtime: ${res.error.message}`);
  process.exit(1);
}
if (res.signal) {
  process.kill(process.pid, res.signal);
}
process.exit(res.status ?? 1);
