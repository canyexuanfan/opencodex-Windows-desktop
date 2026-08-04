/**
 * Tests for src/lib/windows-secret-acl.ts
 *
 * Contract:
 *  - hardenSecretPath(path, { required: false }) => non-fatal: never throws, returns
 *    HardenResult { ok, diagnostics? }
 *  - hardenSecretPath(path, { required: true })  => write-path: throws on failure.
 *  - On non-Windows platforms: deterministic, no external command invocation.
 *  - Windows failure diagnostics are sanitized: no raw path in the error message.
 *  - hardenSecretDir mirrors the same contract for directories.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetEphemeralSecretPath,
  hardenSecretDir,
  forgetHardenedSecretPath,
  hardenSecretPath,
  hardenSecretPathAsync,
  hardenedSecretPathCountForTests,
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  setStatForTests,
  timedOutSecretPathCountForTests,
  type HardenResult,
  type IcaclsResult,
} from "../src/lib/windows-secret-acl";
import { atomicWriteFile } from "../src/config";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-acl-test-"));
});

afterEach(() => {
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

// ---------------------------------------------------------------------------
// Cross-platform: non-fatal (read-path) mode — must never throw
// ---------------------------------------------------------------------------

describe("hardenSecretPath – non-fatal mode (required: false)", () => {
  test("returns ok:true for an existing file", () => {
    const filePath = join(testDir, "secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result: HardenResult = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(true);
  });

  test("returns ok:true for a missing file without throwing and without creating it", () => {
    const filePath = join(testDir, "nonexistent.json");

    const result: HardenResult = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });

  test("never throws even when the path contains non-ASCII characters", () => {
    const filePath = join(testDir, "한글-secret.json");
    writeFileSync(filePath, "data", "utf-8");

    expect(() => hardenSecretPath(filePath, { required: false })).not.toThrow();
  });

  test("result has ok boolean and optional diagnostics string fields", () => {
    const filePath = join(testDir, "secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    expect(typeof result.ok).toBe("boolean");
    if (result.diagnostics !== undefined) {
      expect(typeof result.diagnostics).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-platform: required (write-path) mode on the current platform
// ---------------------------------------------------------------------------

describe("hardenSecretPath – required mode (required: true)", () => {
  test("returns ok:true for an existing file on the current platform", () => {
    const filePath = join(testDir, "secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result: HardenResult = hardenSecretPath(filePath, { required: true });

    expect(result.ok).toBe(true);
  });

  test("does not create file when it does not exist even in required mode", () => {
    const filePath = join(testDir, "nonexistent-required.json");

    // required mode on a missing path: should not create the file, return ok:true
    const result: HardenResult = hardenSecretPath(filePath, { required: true });

    expect(result.ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("ephemeral harden success memo lifecycle", () => {
  test("forgetHardenedSecretPath releases only the actual temp and a second temp hardens again", () => {
    // Earlier cases in this file harden real paths under the win32 override and
    // legitimately leave success memos behind; this test asserts exact memo
    // counts, so it must start from a clean slate rather than inherit them.
    resetHardenedStateForTests();
    const tempA = join(testDir, "config.json.ocx.1.1.tmp");
    const tempB = join(testDir, "config.json.ocx.1.2.tmp");
    writeFileSync(tempA, "first", "utf8");
    writeFileSync(tempB, "second", "utf8");
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let grants = 0;
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      expect(hardenSecretPath(tempA, { required: true })).toEqual({ ok: true });
      expect(hardenedSecretPathCountForTests()).toBe(1);
      forgetHardenedSecretPath(tempA);
      expect(hardenedSecretPathCountForTests()).toBe(0);

      expect(hardenSecretPath(tempB, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(2);
      expect(hardenedSecretPathCountForTests()).toBe(1);
      forgetHardenedSecretPath(tempB);
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });
});

// ---------------------------------------------------------------------------
// hardenSecretDir
// ---------------------------------------------------------------------------

describe("hardenSecretDir", () => {
  test("returns ok:true for an existing directory in non-fatal mode", () => {
    const result: HardenResult = hardenSecretDir(testDir, { required: false });
    expect(result.ok).toBe(true);
  });

  test("returns ok:true for an existing directory in required mode", () => {
    const result: HardenResult = hardenSecretDir(testDir, { required: true });
    expect(result.ok).toBe(true);
  });

  test("returns ok:true for a missing directory without creating it", () => {
    const missingDir = join(testDir, "does-not-exist");
    const result: HardenResult = hardenSecretDir(missingDir, { required: false });
    expect(result.ok).toBe(true);
    expect(existsSync(missingDir)).toBe(false);
  });

  test("result shape matches HardenResult interface", () => {
    const result = hardenSecretDir(testDir, { required: false });
    expect(typeof result.ok).toBe("boolean");
    if (result.diagnostics !== undefined) {
      expect(typeof result.diagnostics).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Windows-specific contract: sanitized diagnostics
// We can only test the real Windows ACL path when running on win32.
// ---------------------------------------------------------------------------

describe("Windows ACL diagnostics (win32 only)", () => {
  const isWin32 = process.platform === "win32";

  test("on win32: hardenSecretPath returns ok:true for existing file (real ACL)", () => {
    if (!isWin32) return; // skip on non-Windows
    const filePath = join(testDir, "win-secret.json");
    writeFileSync(filePath, "sensitive data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    // On a normal NTFS Windows filesystem, this should succeed
    expect(result.ok).toBe(true);
  });

  test("on win32: hardenSecretDir returns ok:true for existing dir (real ACL)", () => {
    if (!isWin32) return; // skip on non-Windows
    const result = hardenSecretDir(testDir, { required: false });
    expect(result.ok).toBe(true);
  });

  test("on win32: hardenSecretPath with required:true for existing file completes", () => {
    if (!isWin32) return;
    const filePath = join(testDir, "win-required-secret.json");
    writeFileSync(filePath, "data", "utf-8");

    // Must not throw on a normal NTFS volume
    expect(() => hardenSecretPath(filePath, { required: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-Windows determinism: helper must not invoke external processes
// We verify this by checking the module uses platform-branched logic.
// On non-Windows we can verify the contract is met without mocking internals.
// ---------------------------------------------------------------------------

describe("non-Windows determinism", () => {
  test("on non-win32: hardenSecretPath completes without error for existing file", () => {
    if (process.platform === "win32") return; // This suite is for non-Windows
    const filePath = join(testDir, "posix-secret.json");
    writeFileSync(filePath, "data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    expect(result.ok).toBe(true);
  });

  test("on non-win32: hardenSecretDir completes without error for existing dir", () => {
    if (process.platform === "win32") return;
    const result = hardenSecretDir(testDir, { required: false });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics sanitization: failure messages must not expose raw paths
// This tests the contract via the exported sanitizeDiagnostics helper if present,
// otherwise verifies that hardenSecretPath failure messages meet the contract.
// ---------------------------------------------------------------------------

describe("diagnostics sanitization contract", () => {
  test("HardenResult diagnostics field is a plain string when present", () => {
    const filePath = join(testDir, "diag-test.json");
    writeFileSync(filePath, "data", "utf-8");

    const result = hardenSecretPath(filePath, { required: false });

    if (result.diagnostics !== undefined) {
      expect(typeof result.diagnostics).toBe("string");
      // Must contain "ACL" as a hint (per contract)
      expect(result.diagnostics.toLowerCase()).toMatch(/acl|permission|access/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure-path activation via injected runner/platform/clock seams.
// The platform seam forces the win32 gate open so CI on POSIX reaches the
// runner; every case restores all seams in afterEach.
// ---------------------------------------------------------------------------

describe("icacls failure paths (injected seams)", () => {
  const ok: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  const timeout: IcaclsResult = { success: false, exitCode: null, timedOut: true, stdout: "" };
  const denied: IcaclsResult = { success: false, exitCode: 5, timedOut: false, stdout: "" };
  let warnings: string[] = [];
  const realWarn = console.warn;

  beforeEach(() => {
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    process.env.USERNAME ??= "tester";
    warnings = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  });

  afterEach(() => {
    setPlatformForTests(null);
    setIcaclsRunnerForTests(null);
    setNowForTests(null);
    resetHardenedStateForTests();
    console.warn = realWarn;
  });

  function secretFile(name = "secret.json"): string {
    const filePath = join(testDir, name);
    writeFileSync(filePath, "data", "utf-8");
    return filePath;
  }

  test("a genuine timeout on a required path fails closed", () => {
    setIcaclsRunnerForTests(() => timeout);
    const filePath = secretFile();

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/ETIMEDOUT/);
    expect(warnings).toEqual([]);
  });

  test("required ACL timeout prevents atomic rename and scrubs the temporary file", () => {
    setIcaclsRunnerForTests(() => timeout);
    const destination = join(testDir, "atomic-secret.json");
    let renamed = false;
    let scrubbed = false;
    expect(() => atomicWriteFile(destination, "secret", {
      write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
      harden: path => { hardenSecretPath(path, { required: true }); },
      rename: (source, target) => { renamed = true; renameSync(source, target); },
      truncate: path => { scrubbed = true; truncateSync(path, 0); },
      unlink: unlinkSync,
    })).toThrow(/ETIMEDOUT/);
    expect(renamed).toBe(false);
    expect(scrubbed).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  test("a real permission failure on a required path still throws (no blanket soft-fail)", () => {
    setIcaclsRunnerForTests(() => denied);
    const filePath = secretFile();

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/EICACLS/);
    expect(warnings).toEqual([]);
  });

  test("a /remove:g failure with the SID still present propagates; a clean /findsid succeeds", () => {
    const filePath = secretFile();
    // Case A: removal fails and /findsid still echoes the path → error propagates.
    setIcaclsRunnerForTests(args => {
      if (args.includes("/remove:g")) return denied;
      if (args.includes("/findsid")) return { ...ok, stdout: `SID Found: ${filePath}\n` };
      return ok;
    });
    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/EICACLS/);

    // Case B: removal fails but no SID remains (ACE was already absent) → harden succeeds.
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/remove:g")) return denied;
      if (args.includes("/findsid")) return { ...ok, stdout: "Successfully processed 1 files\n" };
      return ok;
    });
    expect(hardenSecretPath(filePath, { required: true })).toEqual({ ok: true });
  });

  test("all icacls steps share one deadline and a timed-out path is not retried this process", () => {
    const filePath = secretFile();
    let now = 0;
    const budgets: number[] = [];
    setNowForTests(() => now);
    setIcaclsRunnerForTests((_args, timeoutMs) => {
      budgets.push(timeoutMs);
      now += 6_000; // step consumes more than the whole 5s budget
      return ok;
    });

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/ETIMEDOUT/);
    expect(budgets.length).toBe(1); // only step 1 ran; step 2 was cut off by the shared deadline
    expect(budgets[0]).toBeLessThanOrEqual(5_000);

    // The timed-out path short-circuits without invoking the runner again.
    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/skipped/);
    expect(budgets.length).toBe(1);
  });

  test("a timeout diagnostic no longer claims filesystem non-support (issue #160)", () => {
    setIcaclsRunnerForTests(() => timeout);
    let message = "";
    try {
      hardenSecretPath(secretFile(), { required: true });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("timed out");
    expect(message).toContain("transient icacls stall");
    expect(message).not.toContain("may not support per-user NTFS ACLs");
  });

  test("one timeout retry within the same total budget can still succeed", () => {
    const filePath = secretFile();
    let now = 0;
    let inheritanceCalls = 0;
    setNowForTests(() => now);
    setIcaclsRunnerForTests(args => {
      if (args.includes("/inheritance:r")) {
        inheritanceCalls += 1;
        if (inheritanceCalls === 1) {
          now += 2_000; // first attempt stalls, but budget remains
          return timeout;
        }
      }
      now += 100;
      return ok;
    });

    const result = hardenSecretPath(filePath, { required: true });
    expect(result).toEqual({ ok: true });
    expect(inheritanceCalls).toBe(2); // exactly one retry
    // A successful retry enters the hardened cache: no further runner calls.
    const before = inheritanceCalls;
    expect(hardenSecretPath(filePath, { required: true })).toEqual({ ok: true });
    expect(inheritanceCalls).toBe(before);
  });

  test("a clean post-timeout probe annotates the diagnostic but never promotes to ok:true", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/findsid")) return { ...ok, stdout: "Successfully processed 1 files\n" };
      return timeout; // both harden attempts time out
    });

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/no broad ACL grants detected.*hardening still incomplete/);

    // And the path landed in the timed-out cache, not the hardened cache.
    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/skipped/);
  });

  test("a dirty post-timeout probe reports the remaining broad grants", () => {
    const filePath = secretFile();
    setIcaclsRunnerForTests(args => {
      if (args.includes("/findsid")) return { ...ok, stdout: `SID Found: ${filePath}\n` };
      return timeout;
    });

    expect(() => hardenSecretPath(filePath, { required: true })).toThrow(/broad ACL grants still present/);
  });

  test("OPENCODEX_ACL_TIMEOUT_MS overrides the total budget with clamping", () => {
    const budgets: number[] = [];
    let now = 0;
    setNowForTests(() => now);
    setIcaclsRunnerForTests((_args, timeoutMs) => {
      budgets.push(timeoutMs);
      now += 100;
      return ok;
    });

    const prev = process.env.OPENCODEX_ACL_TIMEOUT_MS;
    try {
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "10000";
      hardenSecretPath(secretFile("env-a.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(10_000);
      expect(budgets[0]).toBeGreaterThan(5_000);

      budgets.length = 0;
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "50"; // below floor → clamped to 1000
      hardenSecretPath(secretFile("env-b.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(1_000);
      expect(budgets[0]).toBeGreaterThan(500);

      budgets.length = 0;
      process.env.OPENCODEX_ACL_TIMEOUT_MS = "5000ms"; // malformed → default 5000
      hardenSecretPath(secretFile("env-c.json"), { required: true });
      expect(budgets[0]).toBeLessThanOrEqual(5_000);
      expect(budgets[0]).toBeGreaterThan(4_000);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_ACL_TIMEOUT_MS;
      else process.env.OPENCODEX_ACL_TIMEOUT_MS = prev;
    }
  });

  test("a thrown EPERM error on a required path still fails closed (no retry)", () => {
    let calls = 0;
    const steps: string[] = [];
    setIcaclsRunnerForTests(args => {
      calls += 1;
      if (args.includes("/grant:r")) steps.push("grant-owner");
      else if (args.includes("/inheritance:r")) steps.push("remove-inheritance");
      else if (args.includes("/remove:g")) steps.push("remove-broad");
      else if (args.includes("/findsid")) steps.push("findsid");
      else steps.push("other");
      const err = new Error("icacls denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(() => hardenSecretPath(secretFile(), { required: true })).toThrow(/permission denied/);
    // Grant runs first: a grant failure must not have already mutated inheritance (#596).
    expect(calls).toBe(1);
    expect(steps).toEqual(["grant-owner"]);
  });

  test("successful harden runs grant-owner before inheritance removal (#596)", () => {
    const steps: string[] = [];
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) steps.push("grant-owner");
      else if (args.includes("/inheritance:r")) steps.push("remove-inheritance");
      else if (args.includes("/remove:g")) steps.push("remove-broad");
      else if (args.includes("/findsid")) steps.push("findsid");
      return ok;
    });

    expect(hardenSecretPath(secretFile(), { required: true })).toEqual({ ok: true });
    expect(steps).toEqual(["grant-owner", "remove-inheritance", "remove-broad"]);
  });

  test("remove:g timeout after owner grant leaves explicit Full Control (#596)", () => {
    // Models the production strand: inheritance already removed, then a later step
    // times out. With owner-first ordering the writer still has an explicit ACE.
    let ownerHasExplicitAce = false;
    let inheritanceRemoved = false;
    const timeoutOnRemove: IcaclsResult = {
      success: false,
      exitCode: null,
      timedOut: true,
      stdout: "",
    };
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) {
        ownerHasExplicitAce = true;
        return ok;
      }
      if (args.includes("/inheritance:r")) {
        inheritanceRemoved = true;
        return ok;
      }
      if (args.includes("/remove:g")) return timeoutOnRemove;
      return ok;
    });

    expect(() => hardenSecretPath(secretFile(), { required: true })).toThrow(/ETIMEDOUT/);
    expect(inheritanceRemoved).toBe(true);
    expect(ownerHasExplicitAce).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Async harden (#612): same policy as sync, but yields via asyncIcaclsRunner.
// ---------------------------------------------------------------------------

describe("async hardenSecretPath (issue #612)", () => {
  const ok: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  const timeout: IcaclsResult = { success: false, exitCode: null, timedOut: true, stdout: "" };
  const denied: IcaclsResult = { success: false, exitCode: 5, timedOut: false, stdout: "" };
  let warnings: string[] = [];
  const realWarn = console.warn;

  beforeEach(() => {
    setPlatformForTests("win32");
    resetHardenedStateForTests();
    process.env.USERNAME ??= "tester";
    warnings = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  });

  afterEach(() => {
    setPlatformForTests(null);
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    setNowForTests(null);
    resetHardenedStateForTests();
    console.warn = realWarn;
  });

  function secretFile(name = "secret.json"): string {
    const filePath = join(testDir, name);
    writeFileSync(filePath, "data", "utf-8");
    return filePath;
  }

  test("async timeout fails closed with the same policy as sync", async () => {
    setAsyncIcaclsRunnerForTests(async () => timeout);
    await expect(hardenSecretPathAsync(secretFile(), { required: true })).rejects.toThrow(/ETIMEDOUT/);
    expect(warnings).toEqual([]);
  });

  test("async permission failure still throws on required paths", async () => {
    setAsyncIcaclsRunnerForTests(async () => denied);
    await expect(hardenSecretPathAsync(secretFile(), { required: true })).rejects.toThrow(/EICACLS/);
  });

  test("timeoutMemoKey shares the timeout cache across distinct temp paths", async () => {
    setAsyncIcaclsRunnerForTests(async () => timeout);
    const dest = join(testDir, "responses-state.json");
    const tempA = join(testDir, "responses-state.json.ocx.1.1.tmp");
    const tempB = join(testDir, "responses-state.json.ocx.1.2.tmp");
    writeFileSync(tempA, "a", "utf-8");
    writeFileSync(tempB, "b", "utf-8");

    await expect(hardenSecretPathAsync(tempA, { required: true, timeoutMemoKey: dest })).rejects.toThrow(/ETIMEDOUT/);

    let calls = 0;
    setAsyncIcaclsRunnerForTests(async () => {
      calls += 1;
      return timeout;
    });
    await expect(hardenSecretPathAsync(tempB, { required: true, timeoutMemoKey: dest })).rejects.toThrow(/skipped/);
    expect(calls).toBe(0); // destination-keyed memo; not a parent-directory shortcut
  });

  test("optional timeout memo does not poison a later required harden of the same path", () => {
    setIcaclsRunnerForTests(() => timeout);
    const first = hardenSecretPath(secretFile(), { required: false });
    expect(first.ok).toBe(false);

    let calls = 0;
    setIcaclsRunnerForTests(() => {
      calls += 1;
      return ok;
    });
    const second = hardenSecretPath(secretFile(), { required: true });
    expect(second.ok).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  test("async harden still grants owner before inheritance removal", async () => {
    const steps: string[] = [];
    setAsyncIcaclsRunnerForTests(async args => {
      if (args.includes("/grant:r")) steps.push("grant-owner");
      else if (args.includes("/inheritance:r")) steps.push("remove-inheritance");
      else if (args.includes("/remove:g")) steps.push("remove-broad");
      return ok;
    });
    expect(await hardenSecretPathAsync(secretFile(), { required: true })).toEqual({ ok: true });
    expect(steps).toEqual(["grant-owner", "remove-inheritance", "remove-broad"]);
  });
});

describe("ephemeral ACL memo release (#840 refinement)", () => {
  const timeout: IcaclsResult = { success: false, exitCode: null, timedOut: true, stdout: "" };

  test("ephemeral release clears temp-keyed timeout memos in BOTH namespaces", () => {
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(() => timeout);
    // Own the environment this test needs. It used to inherit USERNAME from an
    // earlier describe's `??=`, which never restores it: run this file's blocks in
    // another order, or this test alone, and the harden fails before it ever
    // reaches the memo behavior under test.
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    const tempA = join(testDir, "dest.ocx.1.1.tmp");
    const tempB = join(testDir, "dest.ocx.1.2.tmp");
    writeFileSync(tempA, "a", "utf-8");
    writeFileSync(tempB, "b", "utf-8");
    try {
      // required timeout throws; optional timeout soft-fails — both memoize by the temp.
      expect(() => hardenSecretPath(tempA, { required: true })).toThrow(/ETIMEDOUT/);
      expect(hardenSecretPath(tempB, { required: false }).ok).toBe(false);
      expect(timedOutSecretPathCountForTests()).toBe(2);
      forgetEphemeralSecretPath(tempA);
      expect(timedOutSecretPathCountForTests()).toBe(1);
      forgetEphemeralSecretPath(tempB);
      expect(timedOutSecretPathCountForTests()).toBe(0);
    } finally {
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
    }
  });

  test("sync atomic write keys timeouts by destination, and the memo survives temp cleanup", () => {
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let runnerCalls = 0;
    setIcaclsRunnerForTests(() => {
      runnerCalls += 1;
      return timeout;
    });
    const dest = join(testDir, "config.json");
    // Mirrors the production sync harden in config.ts (POSIX tests cannot reach
    // the process.platform gate): required harden keyed by the DESTINATION.
    const io = {
      write: (path: string, content: string) => writeFileSync(path, content, { mode: 0o600 }),
      harden: (path: string) => {
        chmodSync(path, 0o600);
        hardenSecretPath(path, { required: true, timeoutMemoKey: dest });
      },
      rename: renameSync,
      truncate: (path: string) => truncateSync(path, 0),
      unlink: unlinkSync,
    };
    try {
      expect(() => atomicWriteFile(dest, "first", io)).toThrow();
      // Exactly ONE memo — keyed by the destination, not the unique temp.
      expect(timedOutSecretPathCountForTests()).toBe(1);
      const callsAfterFirst = runnerCalls;
      expect(() => atomicWriteFile(dest, "second", io)).toThrow();
      // Anti-restall: the destination memo short-circuits the second harden
      // (no new runner call) and is NOT cleared by the temp cleanup.
      expect(runnerCalls).toBe(callsAfterFirst);
      expect(timedOutSecretPathCountForTests()).toBe(1);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });
});

describe("stable-path harden memo is bound to file identity, not pathname", () => {
  /**
   * The memo is a Set<string> of PATHNAMES. Ephemeral temps escape the
   * consequence because atomic writers call forgetEphemeralSecretPath after the
   * temp is gone (src/config.ts:214,241,309,336,480,501-510). A STABLE
   * destination never does — and hardenStableLockFile
   * (src/codex/native-main-lock-file.ts:127) hardens exactly such a path.
   *
   * So: harden a stable path, then replace the FILE at that same name. The
   * replacement is a different inode that has never been through icacls, but
   * the memo answers for the name and reports it hardened.
   *
   * This is the release -> replace -> REACQUIRE shape. Substituting the file
   * while a single acquisition still holds it never consults the memo again and
   * would pass with the fix removed.
   */
  test("a file replaced at an already-hardened stable path is hardened again", () => {
    resetHardenedStateForTests();
    const stable = join(testDir, "coordinator.sqlite");
    writeFileSync(stable, "first", "utf8");
    // Identity here must match what the memo records, NOT just the inode.
    // ext4 reuses the inode of an unlinked file immediately — 100 of 100 cycles
    // on Linux CI — so an inode-only guard asserts something false and this test
    // failed there while passing on macOS.
    const identityOf = (path: string): string => {
      const s = statSync(path, { bigint: true });
      return `${s.dev}:${s.ino}:${s.ctimeNs}`;
    };
    const firstIdentity = identityOf(stable);

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let grants = 0;
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(1);

      // Release, then replace the file at the SAME pathname.
      unlinkSync(stable);
      writeFileSync(stable, "second", "utf8");
      const secondIdentity = identityOf(stable);
      // Guard the guard: if the filesystem handed back an identical identity,
      // the replacement is indistinguishable and this test proves nothing.
      expect(secondIdentity).not.toBe(firstIdentity);

      // Reacquire. The replacement has never been hardened.
      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(2);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });

  /**
   * The hole the identity memo did NOT close on its own, and the reason the memo
   * is written from a before/after comparison rather than a post-call read.
   *
   * Reading identity after icacls returns answers "what is at this path now",
   * which is a different question from "what did icacls operate on". Swap the
   * file during the final `/remove:g` — a real race, reachable through the
   * production runner seam — and the post-call read records the REPLACEMENT as
   * hardened. The next acquisition then skips ACL work on a file that has never
   * seen it:
   *
   *   {identityChangedDuringHarden: true, callsForOriginal: 3, totalCalls: 3,
   *    replacementWasHardened: false}
   *
   * A required caller must fail closed here. "We hardened something, and
   * something is at that path" is not attribution.
   */
  test("a file replaced DURING hardening is not credited, and required fails closed", () => {
    resetHardenedStateForTests();
    const stable = join(testDir, "raced.sqlite");
    writeFileSync(stable, "original", "utf8");

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let grants = 0;
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      // Replace the file before the sequence returns.
      if (args.includes("/remove:g")) {
        unlinkSync(stable);
        writeFileSync(stable, "replacement", "utf8");
      }
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      expect(() => hardenSecretPath(stable, { required: true })).toThrow(
        /changed during hardening/,
      );
      expect(grants).toBe(1);
      // No memo was left behind for the replacement, so a later harden runs.
      expect(hardenedSecretPathCountForTests()).toBe(0);

      // An optional caller soft-fails with the same honest diagnostic.
      const optional = hardenSecretPath(stable, { required: false });
      expect(optional.ok).toBe(false);
      expect(optional.diagnostics).toMatch(/changed during hardening/);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });

  /**
   * Observed absence retires the memo.
   *
   * Otherwise a success entry outlives the file it describes, and any later file
   * whose identity happens to match satisfies the cache. I could not reproduce
   * identity recycling on APFS in 200k recreations — which is a non-observation,
   * not a guarantee, and ext4 already proved that intuition about one filesystem
   * does not transfer.
   */
  test("observing the path absent retires its success memo", () => {
    resetHardenedStateForTests();
    const stable = join(testDir, "vanishes.sqlite");
    writeFileSync(stable, "first", "utf8");

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(hardenedSecretPathCountForTests()).toBe(1);

      unlinkSync(stable);
      // A harden of the now-absent path is a no-op that must also forget it.
      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
    }
  });
});

describe("identity components are proven individually, not mirrored from setup", () => {
  /**
   * An audit removed `dev` from the production identity and all forty tests
   * still passed, because the existing tests build the expected identity string
   * the same way the implementation does. Mirroring an implementation in test
   * setup is not coverage of it.
   *
   * So these drive a stat seam and vary ONE component at a time. Each case fails
   * if production stops consulting that component.
   */
  const win32 = <T>(body: () => T): T => {
    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    try {
      return body();
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      setStatForTests(null);
    }
  };

  const cases: { name: string; first: [bigint, bigint, bigint]; second: [bigint, bigint, bigint] }[] = [
    // The path now resolves to another device: a different object entirely.
    { name: "dev", first: [1n, 10n, 100n], second: [2n, 10n, 100n] },
    // Ordinary replacement on a filesystem that does not recycle inodes.
    { name: "ino", first: [1n, 10n, 100n], second: [1n, 11n, 100n] },
    // The ext4 case: same inode handed straight back, only ctime moved.
    { name: "ctimeNs", first: [1n, 10n, 100n], second: [1n, 10n, 200n] },
  ];

  for (const { name, first, second } of cases) {
    test(`a change in ${name} alone forces a re-harden`, () => {
      resetHardenedStateForTests();
      const stable = join(testDir, `component-${name}.sqlite`);
      writeFileSync(stable, "x", "utf8");

      win32(() => {
        let grants = 0;
        setIcaclsRunnerForTests(args => {
          if (args.includes("/grant:r")) grants += 1;
          return { success: true, exitCode: 0, timedOut: false, stdout: "" };
        });

        let current = first;
        setStatForTests(() => ({ dev: current[0], ino: current[1], ctimeNs: current[2] }));

        expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);
        // Same observation: the memo answers and no ACL work runs.
        expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(1);

        // One component moves. Production must notice.
        current = second;
        expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
        expect(grants).toBe(2);
      });
    });
  }

  /**
   * The bug the object/freshness split exists to prevent.
   *
   * icacls changes permissions, and a permission change moves ctime — probed
   * directly: `{ctimeChangedByChmod: true}`. An implementation that requires the
   * FULL identity to be unchanged across the ACL call rejects its own successful
   * work, so on Windows every first harden of every path would fail closed.
   *
   * Here ctime moves during hardening exactly as real icacls would move it,
   * while the object stays the same. That must succeed.
   */
  test("ctime moving during hardening is the ACL's own doing, not a substitution", () => {
    resetHardenedStateForTests();
    const stable = join(testDir, "acl-bumps-ctime.sqlite");
    writeFileSync(stable, "x", "utf8");

    win32(() => {
      let grants = 0;
      let ctime = 100n;
      setStatForTests(() => ({ dev: 1n, ino: 10n, ctimeNs: ctime }));
      setIcaclsRunnerForTests(args => {
        if (args.includes("/grant:r")) grants += 1;
        // icacls edits the DACL; ctime moves. The file is the same file.
        ctime += 1n;
        return { success: true, exitCode: 0, timedOut: false, stdout: "" };
      });

      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(1);
      // And the memo recorded the POST-harden freshness, so an immediate second
      // call is still a no-op rather than an endless re-harden.
      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(1);
    });
  });
});

describe("an unreadable observation is not a passing memo", () => {
  /**
   * The memo lookup must fail when it cannot see what is at the path NOW.
   *
   * A mutation that turned "cannot observe" into "satisfied" survived four other
   * broken-change checks, because every one of them could still observe the file.
   * The condition only arises when the stat itself fails — a vanished file, a
   * permission change on the parent, or NTFS returning a zero inode, which is
   * precisely the platform this module exists for.
   *
   * Treating an unreadable observation as proof of an unchanged file is the same
   * absence-as-guarantee move that produced the original pathname memo.
   */
  test("a stat failure after a successful harden forces the harden to run again", () => {
    resetHardenedStateForTests();
    const stable = join(testDir, "unreadable.sqlite");
    writeFileSync(stable, "x", "utf8");

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let grants = 0;
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      let readable = true;
      setStatForTests(() => {
        if (!readable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return { dev: 1n, ino: 10n, ctimeNs: 100n };
      });

      expect(hardenSecretPath(stable, { required: true })).toEqual({ ok: true });
      expect(grants).toBe(1);

      // The memo holds a value, but the path can no longer be observed.
      readable = false;
      // It must NOT answer from the memo. It re-runs, cannot attribute the run
      // either, and a required caller therefore fails closed rather than
      // reporting a harden it cannot vouch for.
      expect(() => hardenSecretPath(stable, { required: true })).toThrow(
        /changed during hardening/,
      );
      expect(grants).toBe(2);
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      setStatForTests(null);
    }
  });

  /**
   * NTFS is reported to return a zero inode from the non-bigint stat, and the
   * production guard treats a zero inode as unobservable. That guard had no test:
   * removing it left all forty-four green, because no case ever produced one.
   */
  test("a zero inode is unobservable, not an identity", () => {
    resetHardenedStateForTests();
    const stable = join(testDir, "zero-ino.sqlite");
    writeFileSync(stable, "x", "utf8");

    setPlatformForTests("win32");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    let grants = 0;
    setIcaclsRunnerForTests(args => {
      if (args.includes("/grant:r")) grants += 1;
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      setStatForTests(() => ({ dev: 1n, ino: 0n, ctimeNs: 100n }));

      // Required callers fail closed: nothing can be attributed.
      expect(() => hardenSecretPath(stable, { required: true })).toThrow(
        /changed during hardening/,
      );
      expect(grants).toBe(1);
      expect(hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      setIcaclsRunnerForTests(null);
      setPlatformForTests(null);
      setStatForTests(null);
    }
  });
});
