import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  WindowsElevationError,
  runWindowsElevated,
  setWindowsElevationSpawnForTests,
} from "../src/lib/windows-elevation";

describe("runWindowsElevated spawn contract", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setWindowsElevationSpawnForTests(null);
  });

  function fakeChild(opts: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
    emitError?: NodeJS.ErrnoException;
    hang?: boolean;
  }) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding?: (enc: string) => void };
      stderr: EventEmitter & { setEncoding?: (enc: string) => void };
      kill: ReturnType<typeof mock>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stderr.setEncoding = () => undefined;
    child.kill = mock(() => true);
    setWindowsElevationSpawnForTests((() => {
      queueMicrotask(() => {
        if (opts.emitError) {
          child.emit("error", opts.emitError);
          return;
        }
        if (opts.hang) return;
        if (opts.stdout) child.stdout.emit("data", opts.stdout);
        if (opts.stderr) child.stderr.emit("data", opts.stderr);
        child.emit("close", "code" in opts ? opts.code! : 0, opts.signal ?? null);
      });
      return child as never;
    }) as never);
    return child;
  }

  test("returns exit code 0", async () => {
    fakeChild({ code: 0 });
    await expect(runWindowsElevated("schtasks.exe", ["/query"])).resolves.toBe(0);
  });

  test("returns non-zero exit codes from completed elevated processes", async () => {
    fakeChild({ code: 1, stderr: "failed" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("maps exit 1223 to cancelled", async () => {
    fakeChild({ code: 1223 });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      name: "WindowsElevationError",
      reason: "cancelled",
    });
  });

  test("maps PowerShell cancellation text to cancelled", async () => {
    fakeChild({ code: 1, stderr: "Start-Process : The operation was canceled by the user." });
    try {
      await runWindowsElevated("schtasks.exe", ["/create"]);
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsElevationError);
      expect((error as WindowsElevationError).reason).toBe("cancelled");
      expect((error as Error).message).toContain("UAC prompt was cancelled");
    }
  });

  test("maps ENOENT launch failure", async () => {
    fakeChild({ emitError: Object.assign(new Error("spawn powershell ENOENT"), { code: "ENOENT" }) });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });

  test("maps signal termination", async () => {
    fakeChild({ code: null, signal: "SIGTERM" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "terminated",
    });
  });

  test("times out once and kills the launcher without double settlement", async () => {
    const child = fakeChild({ hang: true });
    await expect(runWindowsElevated("schtasks.exe", ["/create"], 20)).rejects.toMatchObject({
      reason: "timeout",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    // Late close after timeout must not resolve the already-settled promise.
    child.emit("close", 0, null);
  });

  test("bounds captured stdout and stderr", async () => {
    const huge = "x".repeat(300_000);
    fakeChild({ code: 1, stdout: huge, stderr: huge });
    // Completes with exit code 1; bounded capture must not throw or hang.
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("rejects on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });
});
