#!/usr/bin/env bun
/**
 * Fetch the Bun canary build from the `oven-sh/bun` GitHub `canary` release.
 *
 * Why GitHub and not npm: npm has no Bun 1.4 line at all (dist-tags on
 * 2026-08-14 were latest=1.3.14, canary=1.3.13-canary.20260425.1), while the
 * GitHub `canary` tag already serves 1.4.0-canary.1. Qualification therefore
 * runs against the GitHub asset via OPENCODEX_BUN_PATH; the npm `bun`
 * dependency stays at the shipped stable version and moves only on release day.
 *
 * Trust model — read before adding a checksum gate. `canary` is a ROLLING tag:
 * its assets are replaced in place, and `SHASUMS256.txt` lags them. Measured
 * 2026-08-14: bun-darwin-aarch64.zip updated 11:52:50Z, SHASUMS256.txt updated
 * the previous day 14:30:31Z, and the published digest did not match a correct
 * download. A hard SHA gate would fail every run. What pins a build here is
 * `Bun.revision` plus the CI run that executed the suite against it, so the
 * checksum is recorded as advisory (`shasumsMatch`) and never fatal.
 *
 * Usage:
 *   bun scripts/runtime/fetch-canary-bun.ts --json
 *   bun scripts/runtime/fetch-canary-bun.ts --print-path
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const RELEASE_API = "https://api.github.com/repos/oven-sh/bun/releases/tags/canary";
const CACHE_ROOT = resolve(process.cwd(), ".tmp", "bun-canary");

export type CanaryFetchResult = {
  path: string;
  version: string;
  revision: string;
  assetName: string;
  sha256: string;
  /** Advisory only: whether SHASUMS256.txt agreed. Never a failure condition. */
  shasumsMatch: boolean | null;
  cached: boolean;
};

/**
 * Map the host to a Bun release asset name.
 *
 * Bun publishes baseline variants for x64 CPUs without AVX2 and musl variants
 * for Alpine-class Linux. We select the mainline asset and let the caller
 * override, because detecting AVX2 or libc from Node reliably is more failure
 * surface than it is worth for a qualification lane.
 */
export function canaryAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  opts: { baseline?: boolean; musl?: boolean } = {},
): string {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x64" : null;
  if (!cpu) throw new Error(`unsupported arch: ${arch}`);

  const parts: string[] = ["bun"];
  if (platform === "darwin") parts.push("darwin", cpu);
  else if (platform === "linux") {
    parts.push("linux", cpu);
    if (opts.musl) parts.push("musl");
  } else if (platform === "win32") {
    if (cpu !== "x64" && cpu !== "aarch64") throw new Error(`unsupported win32 arch: ${arch}`);
    parts.push("windows", cpu);
  } else {
    throw new Error(`unsupported platform: ${platform}`);
  }
  // baseline exists only for x64 targets.
  if (opts.baseline && cpu === "x64") parts.push("baseline");
  return `${parts.join("-")}.zip`;
}

/** The binary path inside an extracted asset directory. */
function binaryNameFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? "bun.exe" : "bun";
}

type ReleaseAsset = { name: string; browser_download_url: string; updated_at: string };

async function fetchReleaseAssets(): Promise<ReleaseAsset[]> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "opencodex-canary-qualify",
  };
  // GitHub Actions provides GITHUB_TOKEN; unauthenticated calls are rate-limited
  // to 60/hour per IP, which a shared CI runner can exhaust.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(RELEASE_API, { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub release lookup failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as { assets?: ReleaseAsset[] };
  if (!body.assets?.length) throw new Error("canary release returned no assets");
  return body.assets;
}

async function download(url: string): Promise<Uint8Array> {
  const headers: Record<string, string> = { "user-agent": "opencodex-canary-qualify" };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) {
    // Drain the body so the socket is not left holding an unconsumed stream.
    await res.body?.cancel("download failed").catch(() => {});
    throw new Error(`asset download failed: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Extract a .zip cross-platform, preferring the platform's built-in tool. */
function extractZip(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const cmd = process.platform === "win32"
    ? { bin: "powershell", args: ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`] }
    : { bin: "unzip", args: ["-q", "-o", zipPath, "-d", destDir] };
  const r = spawnSync(cmd.bin, cmd.args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`extraction failed (${cmd.bin} exit ${r.status ?? "?"})`);
}

/** Locate the bun binary inside an extracted asset tree (one level of nesting). */
function findExtractedBinary(root: string, platform: NodeJS.Platform): string | null {
  const name = binaryNameFor(platform);
  const direct = join(root, name);
  if (existsSync(direct)) return direct;
  // Assets extract into a directory named after the asset, e.g. bun-darwin-aarch64/bun
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    if (!statSync(candidate).isDirectory()) continue;
    const nested = join(candidate, name);
    if (existsSync(nested)) return nested;
  }
  return null;
}

function readRevision(binary: string): { version: string; revision: string } {
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const revision = spawnSync(binary, ["--revision"], { encoding: "utf8" });
  if (version.status !== 0 || revision.status !== 0) {
    throw new Error("downloaded binary did not answer --version/--revision");
  }
  return { version: version.stdout.trim(), revision: revision.stdout.trim() };
}

export async function fetchCanaryBun(
  opts: { baseline?: boolean; musl?: boolean } = {},
): Promise<CanaryFetchResult> {
  const assetName = canaryAssetName(process.platform, process.arch, opts);
  const assets = await fetchReleaseAssets();
  const asset = assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(`asset ${assetName} not present in the canary release (have: ${assets.map(a => a.name).slice(0, 8).join(", ")}…)`);
  }

  const bytes = await download(asset.browser_download_url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Advisory checksum comparison. See the trust-model note at the top of this
  // file: on a rolling tag the manifest lags the assets, so a mismatch is
  // reported and never thrown.
  let shasumsMatch: boolean | null = null;
  const shasums = assets.find(a => a.name === "SHASUMS256.txt");
  if (shasums) {
    try {
      const manifest = new TextDecoder().decode(await download(shasums.browser_download_url));
      const line = manifest.split("\n").find(l => l.includes(assetName));
      const published = line?.trim().split(/\s+/)[0];
      if (published) {
        shasumsMatch = published === sha256;
        if (!shasumsMatch) {
          console.warn(
            `warn: SHASUMS256.txt disagrees for ${assetName} (published ${published.slice(0, 12)}…, got ${sha256.slice(0, 12)}…).\n` +
            `      Expected on a rolling tag whose manifest lags its assets; qualification pins Bun.revision instead.`,
          );
        }
      }
    } catch {
      // Advisory only — never block the fetch on the manifest.
    }
  }

  // Stage into a temp dir, read the revision, then move into the revision-keyed
  // cache. The revision is not known until the binary runs, so it cannot be the
  // download target directory.
  const stageDir = join(CACHE_ROOT, `stage-${process.pid}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  const zipPath = join(stageDir, assetName);
  writeFileSync(zipPath, bytes);
  extractZip(zipPath, stageDir);

  const staged = findExtractedBinary(stageDir, process.platform);
  if (!staged) throw new Error(`no ${binaryNameFor(process.platform)} found inside ${assetName}`);
  if (process.platform !== "win32") chmodSync(staged, 0o755);

  const { version, revision } = readRevision(staged);

  const finalDir = join(CACHE_ROOT, revision.replace(/[^\w.+-]/g, "_"));
  const finalBin = join(finalDir, binaryNameFor(process.platform));
  let cached = false;
  if (existsSync(finalBin)) {
    cached = true;
    rmSync(stageDir, { recursive: true, force: true });
  } else {
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(finalBin, readFileSync(staged));
    if (process.platform !== "win32") chmodSync(finalBin, 0o755);
    rmSync(stageDir, { recursive: true, force: true });
  }

  return { path: finalBin, version, revision, assetName, sha256, shasumsMatch, cached };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opts = { baseline: args.includes("--baseline"), musl: args.includes("--musl") };
  try {
    const result = await fetchCanaryBun(opts);
    if (args.includes("--print-path")) console.log(result.path);
    else console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`fetch-canary-bun: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
