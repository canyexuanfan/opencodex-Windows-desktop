import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  OCX_ELEVATED_CREATE_FAILED,
  OCX_ELEVATED_PROTOCOL_CODES,
  OCX_ELEVATED_PROTOCOL_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
  OCX_ELEVATED_SUCCESS,
  OCX_ELEVATED_UAC_CANCELLED,
  WindowsElevationError,
  buildElevatedSchtasksCreateAndRunScript,
  classifyElevatedSchedulerExitCode,
  runElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  setWindowsElevationSpawnForTests,
} from "../src/lib/windows-elevation";
import {
  finalizeWindowsSchedulerServiceRegistration,
  setFinalizeWindowsSchedulerHooksForTests,
} from "../src/service";

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

  test("PowerShell script treats a missing ExitCode as protocol failure", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
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
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    await runWindowsElevated("schtasks.exe", ["/create"]);
    expect(commandScript).toContain(`if ($null -eq $p.ExitCode) { exit ${OCX_ELEVATED_PROTOCOL_FAILED} }`);
    expect(commandScript).toContain("$null = $p.Handle");
  });

  test("returns non-zero exit codes from completed elevated processes", async () => {
    fakeChild({ code: 1, stderr: "failed" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("maps exit 1223 to cancelled", async () => {
    fakeChild({ code: OCX_ELEVATED_UAC_CANCELLED });
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
    child.emit("close", 0, null);
  });

  test("bounds captured stdout and stderr", async () => {
    const huge = "x".repeat(300_000);
    fakeChild({ code: 1, stdout: huge, stderr: huge });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("rejects on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });
});

describe("elevated scheduler protocol codes", () => {
  test("reserved codes are unique and exclude UAC cancellation", () => {
    const set = new Set<number>(OCX_ELEVATED_PROTOCOL_CODES);
    expect(set.size).toBe(OCX_ELEVATED_PROTOCOL_CODES.length);
    expect(set.has(OCX_ELEVATED_UAC_CANCELLED)).toBe(false);
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_SUCCESS)).toBe("success");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_CREATE_FAILED)).toBe("create-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_RUN_FAILED_ROLLED_BACK)).toBe("run-failed-rolled-back");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED)).toBe("run-failed-rollback-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_PROTOCOL_FAILED)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(1)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(-1)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(99999)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_UAC_CANCELLED)).toBe("protocol-failed");
  });
});

describe("one-UAC create/run/rollback elevated script", () => {
  test("embeds create, run, and delete rollback without a second RunAs or temp file writes", () => {
    const script = buildElevatedSchtasksCreateAndRunScript(
      "C:\\Windows\\System32\\schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/xml", "C:\\Users\\Jane Doe\\task.xml", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    expect(script).toContain("Invoke-OcxSchtasks");
    expect(script).toContain(`exit ${OCX_ELEVATED_CREATE_FAILED}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_SUCCESS}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_RUN_FAILED_ROLLED_BACK}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED}`);
    expect(script).toContain('"C:\\Users\\Jane Doe\\task.xml"');
    expect(script).not.toContain("-Verb RunAs");
    expect(script).not.toMatch(/Set-Content|Out-File|Add-Content|New-Item/i);
    expect(script).not.toMatch(/TEMP|tmpdir|ocx-elev/i);
  });
});

describe("finalizeWindowsSchedulerServiceRegistration", () => {
  const originalPlatform = process.platform;
  let elevateLaunches = 0;
  let writeCount = 0;
  let parentRollbackLaunches = 0;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    elevateLaunches = 0;
    writeCount = 0;
    parentRollbackLaunches = 0;
    setFinalizeWindowsSchedulerHooksForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setFinalizeWindowsSchedulerHooksForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  function okVerify() {
    return {
      taskInstalled: true,
      registrationHealthy: true,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: true,
      detail: "ok",
    };
  }

  function mockParentRollbackSpawn() {
    setWindowsElevationSpawnForTests((() => {
      parentRollbackLaunches += 1;
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
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);
  }

  test("successful create+run uses exactly one elevated launcher and writes install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
    });

    await finalizeWindowsSchedulerServiceRegistration("C:\\Users\\x\\.opencodex\\opencodex-service.cmd");
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(1);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("create failure does not write install state or parent-rollback", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "create-failed", exitCode: OCX_ELEVATED_CREATE_FAILED, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/\/create failed/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("run failure with in-process rollback does not write install state or launch a second UAC", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return {
          outcome: "run-failed-rolled-back",
          exitCode: OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
          stdout: "",
          stderr: "",
        };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/rolled the task back/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("run failure with in-process rollback failure reports partial install", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return {
          outcome: "run-failed-rollback-failed",
          exitCode: OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
          stdout: "",
          stderr: "",
        };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/partial Task Scheduler/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("UAC cancellation during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError(
          "cancelled",
          "Windows administrator approval was required, but the UAC prompt was cancelled or denied.",
        );
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "cancelled" });
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("timeout during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("timeout", "Windows elevation timed out after 20ms. The elevated Task Scheduler process may still be running.");
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "timeout" });
    expect(writeCount).toBe(0);
  });

  test("launch failure during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("launch-failed", "Windows PowerShell was not found for elevation.");
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "launch-failed" });
    expect(writeCount).toBe(0);
  });

  test("signal termination during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("terminated", "Windows elevation terminated by SIGTERM.");
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "terminated" });
    expect(writeCount).toBe(0);
  });

  test("protocol-failed with no task present reconciles without inventing a phase", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "protocol-failed", exitCode: 99, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(writeCount).toBe(0);
  });

  test("protocol-failed with task present attempts parent cleanup and does not write state", async () => {
    mockParentRollbackSpawn();
    let calls = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "protocol-failed", exitCode: OCX_ELEVATED_PROTOCOL_FAILED, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => {
        calls += 1;
        return calls === 1; // present before cleanup, absent after
      },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(elevateLaunches).toBe(1);
    expect(parentRollbackLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("verification conflict rolls back and does not write install state", async () => {
    mockParentRollbackSpawn();
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: () => ({
        taskInstalled: true,
        registrationHealthy: true,
        assetsHealthy: true,
        nativeServiceAbsent: false,
        nativeStatusUnknown: false,
        conflict: true,
        ok: false,
        detail: "CONFLICT: Task Scheduler and native WinSW are both present.",
      }),
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/CONFLICT/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("unknown WinSW status fails closed without claiming conflict and without rollback", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: () => ({
        taskInstalled: true,
        registrationHealthy: true,
        assetsHealthy: true,
        nativeServiceAbsent: false,
        nativeStatusUnknown: true,
        conflict: false,
        ok: false,
        detail: "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent.",
      }),
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/could not verify/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("runElevatedSchtasksCreateAndRun launches PowerShell once and classifies protocol exit", async () => {
    let launches = 0;
    setWindowsElevationSpawnForTests((() => {
      launches += 1;
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
      queueMicrotask(() => child.emit("close", OCX_ELEVATED_SUCCESS, null));
      return child as never;
    }) as never);

    const result = await runElevatedSchtasksCreateAndRun(
      "schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    expect(launches).toBe(1);
    expect(result.outcome).toBe("success");
    expect(result.exitCode).toBe(OCX_ELEVATED_SUCCESS);
  });
});
