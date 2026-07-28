import { describe, expect, test } from "bun:test";
import {
  npmInvocation,
  resolveNpmCommand,
} from "../src/update/npm-invocation.mjs";

const cwd = "C:\\work\\untrusted-project";
const trustedNpm = "C:\\Program Files\\nodejs\\npm.cmd";
const systemCmd = "C:\\Windows\\System32\\cmd.exe";

describe("Windows npm update invocation", () => {
  test("ignores current-directory candidates and resolves npm from an absolute PATH entry", () => {
    const existing = new Set([
      `${cwd}\\npm.cmd`,
      trustedNpm,
    ]);
    const env = {
      PATH: `${cwd};.;C:\\Program Files\\nodejs`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => existing.has(path),
    })).toBe(trustedNpm);

    const invocation = npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd,
      exists: path => existing.has(path),
    });
    expect(invocation).toMatchObject({
      file: systemCmd,
      args: ["/d", "/s", "/c", expect.stringContaining("nodejs\\npm.cmd")],
      options: { windowsVerbatimArguments: true },
    });
    expect(String(invocation?.args.at(-1) ?? "").includes(cwd)).toBe(false);
  });

  test("fails closed when npm is available only from the current directory", () => {
    const env = {
      PATH: `${cwd};.`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };

    expect(resolveNpmCommand("win32", env, {
      cwd,
      exists: path => path === `${cwd}\\npm.cmd`,
    })).toBeNull();
    expect(npmInvocation(["view", "pkg@latest", "version"], "win32", env, {
      cwd,
      exists: path => path === `${cwd}\\npm.cmd`,
    })).toBeNull();
  });
});
