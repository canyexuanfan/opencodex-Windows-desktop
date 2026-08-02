/**
 * Bundled Bun runtime resolution.
 *
 * opencodex ships the Bun runtime via the `bun` npm dependency (esbuild-style:
 * a tiny main package + platform-specific `@oven/bun-*` optionalDependencies,
 * finalized by the package's own postinstall `node install.js`). The npm `bin`
 * launcher (bin/ocx.mjs) and the durable service/shim integrations both need a
 * stable path to that binary. This module is the single source of truth.
 *
 * In a from-source dev checkout the `bun` dependency may be absent; callers fall
 * back to `process.execPath` (which is itself Bun when run via `bun src/cli/index.ts`).
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { isRealBunBinary } from "./bun-binary-validator.mjs";

export { isRealBunBinary };

const require = createRequire(import.meta.url);

const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";

/**
 * Env marker stamped by whichever launcher selected the Bun binary, then read back
 * inside the launched process.
 *
 * Provenance has to travel with the launch because it cannot be recovered afterwards:
 * resolving it at report time answers "what would this shell pick now", not "what was
 * this service started with", and those differ exactly when the answer matters.
 */
export const BUN_RUNTIME_SOURCE_ENV = "OCX_BUN_RUNTIME_SOURCE";

export type BunRuntimeSource = "override" | "bundled" | "process";

/** The only provenance values any surface may accept off the wire or out of the env. */
export const BUN_RUNTIME_SOURCES: readonly BunRuntimeSource[] = ["override", "bundled", "process"];

export type DurableBunRuntime = {
  path: string;
  source: BunRuntimeSource;
  overrideEnv: typeof BUN_OVERRIDE_ENV;
};

/**
 * The provenance this process was launched with, or `undefined` when nothing
 * trustworthy is recorded.
 *
 * Deliberately never falls back to `durableBunRuntime()`. A service installed before
 * the marker existed has no provenance, and guessing one from the current environment
 * would report a confident wrong answer — "unknown" is the honest result and callers
 * are expected to say so. Values outside the allowlist are treated as absent rather
 * than passed through.
 */
export function reportedBunRuntimeSource(
  env: NodeJS.ProcessEnv = process.env,
): BunRuntimeSource | undefined {
  const raw = env[BUN_RUNTIME_SOURCE_ENV]?.trim();
  return BUN_RUNTIME_SOURCES.find(source => source === raw);
}

/**
 * Absolute path to the bundled Bun binary, or null if the `bun` dependency is
 * not installed/resolvable (or only the un-downloaded placeholder is present).
 * The npm `bun` package ships the binary as `bin/bun.exe` on every platform;
 * we also probe `bin/bun` for forward compatibility.
 */
export function bundledBunPath(): string | null {
  try {
    const bunDir = dirname(require.resolve("bun/package.json"));
    for (const name of ["bun.exe", "bun"]) {
      const p = join(bunDir, "bin", name);
      if (isRealBunBinary(p)) return p;
    }
    return null;
  } catch {
    return null;
  }
}

export function overrideBunPath(): string | null {
  const value = process.env[BUN_OVERRIDE_ENV]?.trim();
  if (!value) return null;
  const resolved = resolve(value);
  return isRealBunBinary(resolved) ? resolved : null;
}

export function durableBunRuntime(): DurableBunRuntime {
  const override = overrideBunPath();
  if (override) return { path: override, source: "override", overrideEnv: BUN_OVERRIDE_ENV };
  const bundled = bundledBunPath();
  if (bundled) return { path: bundled, source: "bundled", overrideEnv: BUN_OVERRIDE_ENV };
  return { path: process.execPath, source: "process", overrideEnv: BUN_OVERRIDE_ENV };
}

/**
 * Bun path to bake into durable artifacts (launchd/systemd/Task Scheduler and
 * the Codex auto-start shim). Prefer the bundled binary — it lives under the
 * npm global prefix and survives across `ocx update` — and fall back to the
 * current runtime, which is Bun when launched normally.
 */
export function durableBunPath(): string {
  return durableBunRuntime().path;
}
