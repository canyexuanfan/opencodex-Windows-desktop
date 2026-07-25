import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER } from "../src/lib/windows-elevation";

const execFileMock = mock((
  _file: string,
  _args: string[],
  _options: unknown,
  callback: (error: Error | null, stdout?: string, stderr?: string) => void,
) => {
  callback(null, "", "");
});

const finalizeMock = mock(async () => {});

mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: execFileMock,
}));

const {
  classifyCliInstallFailure,
  installFailureDetail,
  runStartupInstallAction,
  setStartupInstallFinalizeForTests,
} = await import("../src/server/startup-action-control");

describe("startup install elevation retry", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileMock.mockReset();
    finalizeMock.mockReset();
    finalizeMock.mockResolvedValue(undefined);
    setStartupInstallFinalizeForTests(finalizeMock as never);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setStartupInstallFinalizeForTests(null);
  });

  function failCli(message: string) {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error(message), "", message);
    });
  }

  function failCliStreams(stdout: string, stderr: string) {
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback(new Error("Command failed"), stdout, stderr);
    });
  }

  test("retries only for structured schtasks /create access denied", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);

    const result = await runStartupInstallAction("install-service");

    expect(result).toEqual({ message: "Background service installed." });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  test("retries when the create-access-denied marker is on stdout and stderr has noise", async () => {
    failCliStreams(
      `Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`,
      "WARNING: unrelated installer warning",
    );

    const result = await runStartupInstallAction("install-service");

    expect(result).toEqual({ message: "Background service installed." });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  test("retries when the marker is only on stderr", async () => {
    failCliStreams("", `denied\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service")).resolves.toEqual({
      message: "Background service installed.",
    });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  test("does not elevate when marker is absent across both streams", async () => {
    failCliStreams("service install failed", "Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/Access is denied/);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate for WinSW removal access denied", async () => {
    failCli("Cannot remove the native service before switching to Task Scheduler: Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/Cannot remove the native service/);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate for asset-write access denied", async () => {
    failCli("EACCES: permission denied, open 'C:\\Users\\x\\.opencodex\\opencodex-service.cmd'");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/EACCES/);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate for generic access-denied stderr", async () => {
    failCli("Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow("Access is denied.");
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate install-shim", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-shim")).rejects.toThrow(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("does not elevate on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  test("surfaces finalize conflict/rollback failures without reporting success", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    finalizeMock.mockRejectedValue(
      new Error("Elevated Task Scheduler registration did not produce a conflict-free install. CONFLICT: Task Scheduler and native WinSW are both present."),
    );

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/CONFLICT/);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });
});

describe("classifyCliInstallFailure marker transport", () => {
  test("marker in stderr only", () => {
    const failure = classifyCliInstallFailure("", `x\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`, new Error("fail"));
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
  });

  test("marker in stdout only", () => {
    const failure = classifyCliInstallFailure(`x\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`, "", new Error("fail"));
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
  });

  test("marker in stdout plus unrelated stderr warning", () => {
    const failure = classifyCliInstallFailure(
      WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
      "WARNING: noise",
      new Error("Command failed"),
    );
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain("WARNING: noise");
  });

  test("generic access-denied text without marker", () => {
    const failure = classifyCliInstallFailure("", "Access is denied.", new Error("Command failed"));
    expect(failure.code).toBeNull();
  });

  test("marker beyond displayed truncation boundary is preserved", () => {
    const failure = classifyCliInstallFailure(
      `${"x".repeat(3_000)}\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`,
      "stderr-head",
      new Error("Command failed"),
    );
    expect(failure.code).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(failure.detail).toContain("truncated");
  });

  test("falls back to error.message when streams are empty", () => {
    const failure = classifyCliInstallFailure("", "", new Error("only-message"));
    expect(failure.detail).toBe("only-message");
    expect(installFailureDetail("", "", new Error("only-message"))).toBe("only-message");
  });
});
