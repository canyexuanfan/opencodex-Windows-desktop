import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNpmCacheDirectory,
  runNpmCachePreflight,
} from "../src/update/npm-cache-preflight.mjs";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = join(tmpdir(), `ocx-cache-preflight-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("npm cache access pre-flight", () => {
  test("rejects foreign-owned nested entries with a structured reason", () => {
    const foreignCache = tempRoot("foreign");
    const nested = join(foreignCache, "_cacache", "content-v2");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "entry"), "cached");

    const actualUid = process.getuid?.() ?? 0;
    expect(inspectNpmCacheDirectory(foreignCache, { expectedUid: actualUid + 1 })).toEqual({
      ok: false,
      reason: "cache_entry_foreign_owner",
    });
  });

  test("rejects inaccessible nested entries with a structured reason", () => {
    const inaccessibleCache = tempRoot("inaccessible");
    const blocked = join(inaccessibleCache, "_cacache");
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    try {
      expect(inspectNpmCacheDirectory(inaccessibleCache)).toEqual({
        ok: false,
        reason: "cache_entry_inaccessible",
      });
    } finally {
      chmodSync(blocked, 0o700);
    }
  });

  test("lstats normal nested symlinks but never traverses their targets", () => {
    const cache = tempRoot("symlink-cache");
    const missingTarget = join(tempRoot("symlink-target"), "does-not-exist");
    const npx = join(cache, "_npx");
    const nodeModules = join(npx, "123", "node_modules");
    mkdirSync(join(nodeModules, ".bin"), { recursive: true });
    symlinkSync(missingTarget, join(nodeModules, "linked-package"), "dir");
    symlinkSync(missingTarget, join(nodeModules, ".bin", "linked-bin"));

    expect(inspectNpmCacheDirectory(cache)).toEqual({ ok: true, reason: "cache_accessible" });
  });

  test("fails closed on worker timeout", () => {
    const timeoutSpawn = (() => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })) as never;
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: timeoutSpawn })).toEqual({
      ok: false,
      reason: "worker_timeout",
    });
  });

  test("fails closed on malformed worker output", () => {
    const malformedSpawn = (() => ({ status: 0, signal: null, stdout: "worker says /Users/Private Name/.npm is broken", stderr: "" })) as never;
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: malformedSpawn })).toEqual({
      ok: false,
      reason: "worker_output_malformed",
    });

    const contradictorySpawn = (() => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ protocol: 1, ok: true, reason: "cache_entry_foreign_owner" }),
      stderr: "",
    })) as never;
    expect(runNpmCachePreflight({ platform: "linux", spawnSyncFn: contradictorySpawn })).toEqual({
      ok: false,
      reason: "worker_output_malformed",
    });
  });

  test("runs the real worker protocol against npm's configured cache path", () => {
    const cache = tempRoot("worker-round-trip");
    mkdirSync(join(cache, "_cacache"));

    expect(runNpmCachePreflight({
      platform: process.platform === "win32" ? "linux" : process.platform,
      env: { ...process.env, npm_config_cache: cache },
    })).toEqual({ ok: true, reason: "cache_accessible" });
  });

  test("Windows skips explicitly without spawning npm or a worker", () => {
    let spawned = false;
    const spawn = (() => {
      spawned = true;
      throw new Error("must not spawn");
    }) as never;

    expect(runNpmCachePreflight({ platform: "win32", spawnSyncFn: spawn })).toEqual({
      ok: true,
      reason: "windows_skip",
    });
    expect(spawned).toBe(false);
  });
});
