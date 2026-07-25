import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as childProcess from "node:child_process";
import { WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER } from "../src/lib/windows-elevation";
import * as actualService from "../src/service";

const execFileMock = mock((
  _file: string,
  _args: string[],
  _options: unknown,
  callback: (error: Error | null, stdout?: string, stderr?: string) => void,
) => {
  callback(null, "", "");
});

const finalizeWindowsSchedulerServiceRegistrationMock = mock(async () => {});

mock.module("node:child_process", () => ({
  ...childProcess,
  execFile: execFileMock,
}));

mock.module("../src/service", () => ({
  ...actualService,
  finalizeWindowsSchedulerServiceRegistration: finalizeWindowsSchedulerServiceRegistrationMock,
}));

const { installFailureDetail, runStartupInstallAction } = await import("../src/server/startup-action-control");

describe("startup install elevation retry", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    execFileMock.mockReset();
    finalizeWindowsSchedulerServiceRegistrationMock.mockReset();
    finalizeWindowsSchedulerServiceRegistrationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
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
    expect(finalizeWindowsSchedulerServiceRegistrationMock).toHaveBeenCalledTimes(1);
  });

  test("retries when the create-access-denied marker is on stdout and stderr has noise", async () => {
    // Mirrors CLI→proxy boundary: marker must survive even if stderr wins a single-stream pick.
    failCliStreams(
      `Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`,
      "WARNING: unrelated installer warning",
    );

    const result = await runStartupInstallAction("install-service");

    expect(result).toEqual({ message: "Background service installed." });
    expect(finalizeWindowsSchedulerServiceRegistrationMock).toHaveBeenCalledTimes(1);
  });

  test("does not elevate when marker is absent across both streams", async () => {
    failCliStreams("service install failed", "Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/Access is denied/);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });

  test("does not elevate for WinSW removal access denied", async () => {
    failCli("Cannot remove the native service before switching to Task Scheduler: Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/Cannot remove the native service/);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });

  test("does not elevate for asset-write access denied", async () => {
    failCli("EACCES: permission denied, open 'C:\\Users\\x\\.opencodex\\opencodex-service.cmd'");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/EACCES/);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });

  test("does not elevate for generic access-denied stderr", async () => {
    failCli("Access is denied.");
    await expect(runStartupInstallAction("install-service")).rejects.toThrow("Access is denied.");
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });

  test("does not elevate install-shim", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-shim")).rejects.toThrow(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });

  test("does not elevate on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    await expect(runStartupInstallAction("install-service")).rejects.toThrow(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).not.toHaveBeenCalled();
  });

  test("surfaces finalize conflict/rollback failures without reporting success", async () => {
    failCli(`Windows access denied while running Task Scheduler.\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`);
    finalizeWindowsSchedulerServiceRegistrationMock.mockRejectedValue(
      new Error("Elevated Task Scheduler registration did not produce a conflict-free install. CONFLICT: Task Scheduler and native WinSW are both present."),
    );

    await expect(runStartupInstallAction("install-service")).rejects.toThrow(/CONFLICT/);
    expect(finalizeWindowsSchedulerServiceRegistrationMock).toHaveBeenCalledTimes(1);
  });
});

describe("installFailureDetail CLI→proxy marker contract", () => {
  test("combines stderr and stdout so a stdout marker survives stderr noise", () => {
    const detail = installFailureDetail(
      `guidance\n${WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER}`,
      "WARNING: noisy stderr",
      new Error("Command failed"),
    );
    expect(detail).toContain("WARNING: noisy stderr");
    expect(detail).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
  });

  test("caps detail length while preserving the elevation marker", () => {
    const marker = WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER;
    const detail = installFailureDetail(
      `${"x".repeat(3_000)}\n${marker}`,
      "stderr-head",
      new Error("Command failed"),
    );
    expect(detail.length).toBeLessThanOrEqual(2_000 + marker.length + 40);
    expect(detail).toContain(marker);
    expect(detail).toContain("truncated");
  });
});
