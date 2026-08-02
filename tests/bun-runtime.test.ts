import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_RUNTIME_SOURCE_ENV, isRealBunBinary, bundledBunPath, durableBunPath, durableBunRuntime, overrideBunPath, reportedBunRuntimeSource, withProcessRuntimeProvenance } from "../src/lib/bun-runtime";

// realpath the temp root: on macOS /var is a symlink to /private/var, so a path built
// from mkdtemp compares unequal to the same path resolved through process.cwd().
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ocx-bun-runtime-")));
const previousOverride = process.env.OPENCODEX_BUN_PATH;
afterAll(() => {
  if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
  else process.env.OPENCODEX_BUN_PATH = previousOverride;
  rmSync(tmp, { recursive: true, force: true });
});

describe("isRealBunBinary (size gate vs placeholder stub)", () => {
  it("rejects the ~450-byte ASCII placeholder stub", () => {
    const stub = join(tmp, "bun-stub.exe");
    // Mirrors the real stub: a small shell script that errors out.
    writeFileSync(stub, 'echo "Error: Bun\'s postinstall script was not run." >&2\nexit 1\n');
    expect(isRealBunBinary(stub)).toBe(false);
  });

  it("accepts a binary at or above the 1MB threshold", () => {
    const real = join(tmp, "bun-real.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    expect(isRealBunBinary(real)).toBe(true);
  });

  it("rejects a non-existent path", () => {
    expect(isRealBunBinary(join(tmp, "does-not-exist.exe"))).toBe(false);
  });

  it("rejects an empty file", () => {
    const empty = join(tmp, "empty.exe");
    writeFileSync(empty, "");
    expect(isRealBunBinary(empty)).toBe(false);
  });
});

describe("bundledBunPath / durableBunPath", () => {
  it("uses OPENCODEX_BUN_PATH only when it points to a real Bun binary", () => {
    const real = join(tmp, "override-bun.exe");
    const stub = join(tmp, "override-stub.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    writeFileSync(stub, "stub");

    process.env.OPENCODEX_BUN_PATH = stub;
    expect(overrideBunPath()).toBeNull();
    expect(durableBunRuntime().source).not.toBe("override");

    process.env.OPENCODEX_BUN_PATH = real;
    expect(overrideBunPath()).toBe(real);
    expect(durableBunRuntime()).toEqual({
      path: real,
      source: "override",
      overrideEnv: "OPENCODEX_BUN_PATH",
    });
    expect(durableBunPath()).toBe(real);
    if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
    else process.env.OPENCODEX_BUN_PATH = previousOverride;
  });

  it("resolves a relative override against the launcher cwd", () => {
    const launcherCwd = join(tmp, "launcher-cwd");
    const real = join(launcherCwd, "relative-bun.exe");
    const previousCwd = process.cwd();
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    mkdirSync(launcherCwd, { recursive: true });
    writeFileSync(real, Buffer.alloc(1_000_000));

    try {
      process.chdir(launcherCwd);
      process.env.OPENCODEX_BUN_PATH = "  relative-bun.exe  ";
      expect(overrideBunPath()).toBe(real);
      expect(durableBunRuntime()).toEqual({
        path: real,
        source: "override",
        overrideEnv: "OPENCODEX_BUN_PATH",
      });
      expect(durableBunPath()).toBe(real);
    } finally {
      process.chdir(previousCwd);
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
    }
  });

  it("resolves the installed bundled bun binary (dev has the bun dep)", () => {
    const p = bundledBunPath();
    // In this repo the `bun` dependency is installed, so the real binary resolves.
    expect(p).not.toBeNull();
    expect(p).toMatch(/bin[\\/]bun(\.exe)?$/);
    expect(isRealBunBinary(p!)).toBe(true);
  });

  it("durableBunPath returns the bundled path when present, else process.execPath", () => {
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    delete process.env.OPENCODEX_BUN_PATH;
    try {
      const bundled = bundledBunPath();
      const durable = durableBunPath();
      expect(typeof durable).toBe("string");
      expect(durable.length).toBeGreaterThan(0);
      if (bundled) expect(durable).toBe(bundled);
      else expect(durable).toBe(process.execPath);
    } finally {
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
    }
  });
});

describe("reportedBunRuntimeSource (#848 launch-time provenance)", () => {
  it("reads back each allowlisted marker", () => {
    for (const source of ["override", "bundled", "process"] as const) {
      expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: source })).toBe(source);
    }
  });

  it("treats an absent marker as unknown rather than guessing from this process", () => {
    // A service installed before provenance existed has no marker. Reporting a
    // confident wrong origin is exactly the #848 failure, so the answer is undefined.
    expect(reportedBunRuntimeSource({})).toBeUndefined();
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "" })).toBeUndefined();
  });

  it("rejects values outside the allowlist instead of passing them through", () => {
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "system" })).toBeUndefined();
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "OVERRIDE" })).toBeUndefined();
    expect(reportedBunRuntimeSource({ [BUN_RUNTIME_SOURCE_ENV]: "override; rm -rf /" })).toBeUndefined();
  });

  it("does not fall back to the current environment when the marker is missing", () => {
    const inherited = process.env.OPENCODEX_BUN_PATH;
    const real = join(tmp, "provenance-bun.exe");
    mkdirSync(join(tmp), { recursive: true });
    writeFileSync(real, "x".repeat(2 * 1024 * 1024));
    process.env.OPENCODEX_BUN_PATH = real;
    try {
      // durableBunRuntime would say "override" here; the reporter must still say unknown.
      expect(durableBunRuntime().source).toBe("override");
      expect(reportedBunRuntimeSource({})).toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inherited;
    }
  });
});

describe("withProcessRuntimeProvenance (execPath relaunch paths)", () => {
  it("records `process` when the relaunching parent carries no marker", () => {
    // `ocx ensure`, GUI start, restart, and update-relaunch all re-exec
    // process.execPath. Without this they would hand the daemon no provenance at
    // all, and doctor would report unknown for an origin the launcher knew.
    expect(withProcessRuntimeProvenance({})[BUN_RUNTIME_SOURCE_ENV]).toBe("process");
  });

  it("preserves an inherited marker instead of relabeling the same runtime", () => {
    // Re-execing the current runtime does not change how that runtime was obtained,
    // but the claim is only carried forward when it still describes process.execPath.
    const overrideEnv = {
      [BUN_RUNTIME_SOURCE_ENV]: "override",
      OPENCODEX_BUN_PATH: process.execPath,
    };
    expect(withProcessRuntimeProvenance(overrideEnv)[BUN_RUNTIME_SOURCE_ENV]).toBe("override");
    expect(withProcessRuntimeProvenance({ [BUN_RUNTIME_SOURCE_ENV]: "process" })[BUN_RUNTIME_SOURCE_ENV]).toBe("process");
  });

  it("drops an inherited marker that no longer describes the running binary", () => {
    // Inheritance travels down a process tree, so a marker can outlive the binary it
    // was minted for: something launched under a marked process but running a
    // different Bun must not relaunch the daemon claiming that other binary's origin.
    const staleOverride = {
      [BUN_RUNTIME_SOURCE_ENV]: "override",
      OPENCODEX_BUN_PATH: join(tmp, "some-other-bun.exe"),
    };
    expect(withProcessRuntimeProvenance(staleOverride)[BUN_RUNTIME_SOURCE_ENV]).not.toBe("override");

    // Same for a `bundled` claim while the bundled path is not what is executing.
    const bundled = bundledBunPath();
    if (bundled && bundled !== process.execPath) {
      expect(withProcessRuntimeProvenance({ [BUN_RUNTIME_SOURCE_ENV]: "bundled" })[BUN_RUNTIME_SOURCE_ENV]).not.toBe("bundled");
    }
  });

  it("replaces an unrecognized inherited value rather than forwarding it", () => {
    expect(withProcessRuntimeProvenance({ [BUN_RUNTIME_SOURCE_ENV]: "system" })[BUN_RUNTIME_SOURCE_ENV]).toBe("process");
  });

  it("leaves every other variable untouched", () => {
    const result = withProcessRuntimeProvenance({ OCX_SERVICE: "1", PATH: "/usr/bin" });
    expect(result.OCX_SERVICE).toBe("1");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("is applied by every detached proxy launcher that re-execs process.execPath", () => {
    // A launcher added later that copies process.env directly would silently drop
    // provenance again, so the launch sites are pinned here rather than left to review.
    const launchers = [
      "src/cli/index.ts",
      "src/cli/claude.ts",
      "src/cli/opencode.ts",
      "src/server/management/system-restart.ts",
      "src/update/index.ts",
    ];
    for (const relative of launchers) {
      const text = readFileSync(join(import.meta.dir, "..", relative), "utf8");
      const spawnCount = (text.match(/spawn\(process\.execPath/g) ?? []).length;
      const stampCount = (text.match(/env: withProcessRuntimeProvenance\(/g) ?? []).length;
      expect(spawnCount).toBeGreaterThan(0);
      expect(stampCount).toBe(spawnCount);
    }
  });
});
