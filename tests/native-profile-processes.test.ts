import { describe, expect, test } from "bun:test";
import {
  probeNativeCodexProcesses,
  resolveWindowsSystemRoot,
  type NativeProcessExecutor,
} from "../src/codex/native-profile-processes";

describe("native profile process probe", () => {
  test("accepts only a drive-root Windows directory as SystemRoot", () => {
    expect(resolveWindowsSystemRoot(undefined)).toBe("C:\\Windows");
    expect(resolveWindowsSystemRoot("D:\\Windows")).toBe("D:\\Windows");
    expect(resolveWindowsSystemRoot("d:\\WINDOWS\\")).toBe("D:\\Windows");
    expect(resolveWindowsSystemRoot("C:\\Users\\runner\\Windows")).toBe("C:\\Windows");
    expect(resolveWindowsSystemRoot("\\\\server\\share\\Windows")).toBe("C:\\Windows");
    expect(resolveWindowsSystemRoot("relative\\Windows")).toBe("C:\\Windows");
  });

  test("uses the validated PowerShell path and an explicit process-list buffer", async () => {
    const calls: Parameters<NativeProcessExecutor>[] = [];
    const execFile: NativeProcessExecutor = (file, args, options) => {
      calls.push([file, args, options]);
      return "2\n";
    };

    await expect(probeNativeCodexProcesses({
      platform: "win32",
      systemRoot: "C:\\Users\\runner\\fake-root",
      execFile,
    })).resolves.toEqual({ status: "busy", count: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]![2].maxBuffer).toBe(16 * 1024 * 1024);
    expect(calls[0]![2].windowsHide).toBe(true);
  });

  test("sets the same buffer for Unix process lists and excludes its own pid", async () => {
    const calls: Parameters<NativeProcessExecutor>[] = [];
    const execFile: NativeProcessExecutor = (file, args, options) => {
      calls.push([file, args, options]);
      return [
        "41 codex /usr/local/bin/codex",
        "42 codex /usr/local/bin/codex",
        "43 bun /opt/tools/codex --serve",
      ].join("\n");
    };

    await expect(probeNativeCodexProcesses({
      platform: "linux",
      execFile,
      pid: 42,
    })).resolves.toEqual({ status: "busy", count: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("ps");
    expect(calls[0]![1]).toEqual(["-eo", "pid=,comm=,args="]);
    expect(calls[0]![2].maxBuffer).toBe(16 * 1024 * 1024);
  });
});
