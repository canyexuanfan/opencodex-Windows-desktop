import { describe, expect, test } from "bun:test";
import { codexExecInvocation, isSpawnableCodexCandidate } from "../src/codex/catalog";

describe("codexExecInvocation", () => {
  test(".cmd/.bat on win32 route through the shell with a pre-quoted path (spaces survive)", () => {
    expect(codexExecInvocation("C:\\Users\\John Doe\\AppData\\Roaming\\npm\\codex.cmd", "win32")).toEqual({
      file: '"C:\\Users\\John Doe\\AppData\\Roaming\\npm\\codex.cmd"',
      shell: true,
    });
    expect(codexExecInvocation("C:\\npm\\codex.CMD", "win32").shell).toBe(true);
    expect(codexExecInvocation("C:\\npm\\codex.bat", "win32").shell).toBe(true);
  });

  test(".exe and bare names stay shell-less on win32", () => {
    expect(codexExecInvocation("C:\\Tools\\codex.exe", "win32")).toEqual({ file: "C:\\Tools\\codex.exe", shell: false });
    expect(codexExecInvocation("codex", "win32")).toEqual({ file: "codex", shell: false });
  });

  test("posix platforms never use the shell", () => {
    expect(codexExecInvocation("/usr/local/bin/codex", "darwin")).toEqual({ file: "/usr/local/bin/codex", shell: false });
    expect(codexExecInvocation("/weird/codex.cmd", "linux")).toEqual({ file: "/weird/codex.cmd", shell: false });
  });
});

describe("isSpawnableCodexCandidate", () => {
  test("win32 rejects the extensionless sh backup and .ps1 (document-association trap)", () => {
    // Probing these spawns Windows' file association instead of a process, so the
    // backup file OPENS in the user's editor on every codex launch (Windows report).
    expect(isSpawnableCodexCandidate("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.opencodex-real", "win32")).toBe(false);
    expect(isSpawnableCodexCandidate("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.opencodex-real.ps1", "win32")).toBe(false);
    expect(isSpawnableCodexCandidate("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.ps1", "win32")).toBe(false);
  });

  test("win32 keeps real launchers", () => {
    expect(isSpawnableCodexCandidate("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.opencodex-real.cmd", "win32")).toBe(true);
    expect(isSpawnableCodexCandidate("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.opencodex-real.CMD", "win32")).toBe(true);
    expect(isSpawnableCodexCandidate("C:\\npm\\codex.cmd", "win32")).toBe(true);
    expect(isSpawnableCodexCandidate("C:\\Tools\\codex.exe", "win32")).toBe(true);
    expect(isSpawnableCodexCandidate("C:\\npm\\codex.bat", "win32")).toBe(true);
  });

  test("posix accepts everything (sh backups are executable there)", () => {
    expect(isSpawnableCodexCandidate("/usr/local/bin/codex.opencodex-real", "darwin")).toBe(true);
    expect(isSpawnableCodexCandidate("/home/u/.npm-global/bin/codex", "linux")).toBe(true);
  });
});
