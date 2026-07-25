import { describe, expect, test } from "bun:test";
import {
  WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER,
  WindowsSchtasksError,
  buildWindowsElevatedArgumentList,
  formatWindowsSchtasksError,
  isWindowsAccessDenied,
  isWindowsAccessDeniedError,
  isWindowsSchtasksCreateAccessDenied,
  schtasksOperationFromArgs,
  toWindowsSchtasksError,
  windowsCmdQuote,
} from "../src/lib/windows-elevation";

describe("windows elevation helpers", () => {
  test("detects English and German access-denied text", () => {
    expect(isWindowsAccessDenied("FEHLER: Zugriff verweigert")).toBe(true);
    expect(isWindowsAccessDenied("ERROR: Access is denied.")).toBe(true);
    expect(isWindowsAccessDenied("service installed")).toBe(false);
  });

  test("detects access-denied exec errors from stderr", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "FEHLER: Zugriff verweigert\r\n",
      stdout: "",
      status: 1,
    });
    expect(isWindowsAccessDeniedError(error)).toBe(true);
  });

  test("formats schtasks create access-denied errors with marker and UAC guidance", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "FEHLER: Zugriff verweigert\r\n",
      stdout: "",
      status: 1,
    });
    const message = formatWindowsSchtasksError(error, ["/create", "/tn", "opencodex-proxy"]);
    expect(message).toContain("Windows access denied while running Task Scheduler.");
    expect(message).toContain("schtasks /create /tn opencodex-proxy");
    expect(message).toContain("UAC prompt");
    expect(message).toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(isWindowsSchtasksCreateAccessDenied(message)).toBe(true);
  });

  test("does not emit create-access-denied marker for non-create operations", () => {
    const error = Object.assign(new Error("Command failed"), {
      stderr: "Access is denied.",
      stdout: "",
    });
    const message = formatWindowsSchtasksError(error, ["/run", "/tn", "opencodex-proxy"]);
    expect(message).toContain("Windows access denied while running Task Scheduler.");
    expect(message).not.toContain(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(isWindowsSchtasksCreateAccessDenied(message)).toBe(false);
  });

  test("generic access-denied text alone does not classify as create denial", () => {
    expect(isWindowsSchtasksCreateAccessDenied("Access is denied.")).toBe(false);
    expect(isWindowsSchtasksCreateAccessDenied("Cannot remove the native service: Access is denied.")).toBe(false);
    expect(isWindowsSchtasksCreateAccessDenied("EACCES: permission denied, open 'token'")).toBe(false);
  });

  test("toWindowsSchtasksError preserves operation and reason", () => {
    const error = Object.assign(new Error("Command failed"), { stderr: "Access is denied." });
    const structured = toWindowsSchtasksError(error, ["/create", "/xml", "task.xml", "/f"]);
    expect(structured).toBeInstanceOf(WindowsSchtasksError);
    expect(structured.operation).toBe("create");
    expect(structured.reason).toBe("access-denied");
    expect(structured.machineMarker).toBe(WINDOWS_SCHTASKS_CREATE_ACCESS_DENIED_MARKER);
    expect(schtasksOperationFromArgs(["/delete", "/tn", "x"])).toBe("delete");
  });

  test("builds one Win32-quoted argument list for spaced paths", () => {
    expect(buildWindowsElevatedArgumentList([
      "/create",
      "/tn",
      "opencodex-proxy",
      "/xml",
      "C:\\Users\\Jane Doe\\.opencodex\\opencodex-service-task.xml",
      "/f",
    ])).toBe(
      '/create /tn opencodex-proxy /xml "C:\\Users\\Jane Doe\\.opencodex\\opencodex-service-task.xml" /f',
    );
  });

  test("quotes empty args, embedded quotes, trailing backslashes, and unicode paths", () => {
    expect(windowsCmdQuote("")).toBe('""');
    expect(windowsCmdQuote("simple")).toBe("simple");
    expect(windowsCmdQuote('say "hi"')).toBe('"say \\"hi\\""');
    // Unquoted paths keep a single trailing backslash; only quoted args double it.
    expect(windowsCmdQuote("C:\\temp\\")).toBe("C:\\temp\\");
    expect(windowsCmdQuote("C:\\temp dir\\")).toBe('"C:\\temp dir\\\\"');
    expect(windowsCmdQuote("C:\\Users\\한글\\task")).toBe("C:\\Users\\한글\\task");
    expect(windowsCmdQuote("task name with spaces")).toBe('"task name with spaces"');
    expect(buildWindowsElevatedArgumentList(["/tn", "Open Codex Proxy", ""])).toBe(
      '/tn "Open Codex Proxy" ""',
    );
  });

  test("passes through non-access-denied errors unchanged", () => {
    const error = new Error("schtasks is unavailable");
    expect(formatWindowsSchtasksError(error, ["/query"])).toBe("schtasks is unavailable");
  });

  test("elevated executables ignore a hostile SystemRoot", () => {
    if (process.platform !== "win32") return;

    const {
      resolveTrustedWindowsPowerShellExe,
      resolveTrustedWindowsSchtasksExe,
      setTrustedWindowsSystemDirectoryResolverForTests,
      setTrustedWindowsElevationExecutablesForTests,
    } = require("../src/lib/windows-elevation") as typeof import("../src/lib/windows-elevation");

    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    process.env.SystemRoot = "C:\\Users\\Public\\evil-root";
    process.env.WINDIR = "C:\\Users\\Public\\evil-root";
    try {
      // Prove the production GetSystemDirectoryW path ignores env even when poisoned.
      setTrustedWindowsElevationExecutablesForTests(null);
      setTrustedWindowsSystemDirectoryResolverForTests(null);
      const powershell = resolveTrustedWindowsPowerShellExe();
      const schtasks = resolveTrustedWindowsSchtasksExe();
      const evil = "evil-root";
      expect(powershell.toLowerCase().includes(evil)).toBe(false);
      expect(schtasks.toLowerCase().includes(evil)).toBe(false);
      expect(powershell.toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe")).toBe(true);
      expect(schtasks.toLowerCase().endsWith("\\system32\\schtasks.exe")).toBe(true);

      // Fail closed when a hostile resolver returns an untrusted directory.
      setTrustedWindowsSystemDirectoryResolverForTests(() => "C:\\Users\\Public\\evil-root\\System32");
      expect(() => resolveTrustedWindowsPowerShellExe()).toThrow(/not found|unusable|outside the trusted/i);
      expect(() => resolveTrustedWindowsSchtasksExe()).toThrow(/not found|unusable|outside the trusted/i);
    } finally {
      setTrustedWindowsSystemDirectoryResolverForTests(null);
      setTrustedWindowsElevationExecutablesForTests(null);
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
    }
  });
});
