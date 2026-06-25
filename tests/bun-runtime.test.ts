import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRealBunBinary, bundledBunPath, durableBunPath } from "../src/bun-runtime";

const tmp = mkdtempSync(join(tmpdir(), "ocx-bun-runtime-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
  it("resolves the installed bundled bun binary (dev has the bun dep)", () => {
    const p = bundledBunPath();
    // In this repo the `bun` dependency is installed, so the real binary resolves.
    expect(p).not.toBeNull();
    expect(p).toMatch(/bin[\\/]bun(\.exe)?$/);
    expect(isRealBunBinary(p!)).toBe(true);
  });

  it("durableBunPath returns the bundled path when present, else process.execPath", () => {
    const bundled = bundledBunPath();
    const durable = durableBunPath();
    expect(typeof durable).toBe("string");
    expect(durable.length).toBeGreaterThan(0);
    if (bundled) expect(durable).toBe(bundled);
    else expect(durable).toBe(process.execPath);
  });
});
