import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim, installCodexShim, uninstallCodexShim } from "../src/codex-shim";

const SHIM_MARKER = "opencodex codex autostart shim";

describe("Codex autostart shim", () => {
  test("builds a Unix shim that starts ocx before execing Codex", () => {
    const script = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain('exec "/usr/local/bin/codex-real" "$@"');
  });

  test("builds a Windows shim that starts ocx before running Codex", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts");

    expect(script).toContain(SHIM_MARKER);
    expect(script).toContain("ensure");
    expect(script).not.toContain("sync-cache");
    expect(script).toContain('"C:\\Tools\\codex-real.exe" %*');
  });

  test("shim builder output contains the marker that isShim() checks", () => {
    const unix = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts");
    const win = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts");

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const unixPath = join(dir, "codex-shim");
    const winPath = join(dir, "codex-shim.cmd");

    writeFileSync(unixPath, unix, "utf8");
    writeFileSync(winPath, win, "utf8");

    expect(readFileSync(unixPath, "utf8")).toContain(SHIM_MARKER);
    expect(readFileSync(winPath, "utf8")).toContain(SHIM_MARKER);
  });

  test("non-shim file does not contain the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const fakeBinary = join(dir, "codex");
    writeFileSync(fakeBinary, "#!/bin/sh\necho hello\n", "utf8");

    expect(readFileSync(fakeBinary, "utf8")).not.toContain(SHIM_MARKER);
  });

  test("Unix shim uses bypass env var to skip proxy start", () => {
    const script = buildUnixCodexShim("/bin/codex", "/bin/bun", "/cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("Windows shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsCodexShim("C:\\codex.exe", "C:\\bun.exe", "C:\\cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
  });

  test("PowerShell shim uses bypass env var to skip proxy start", () => {
    const script = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts");
    expect(script).toContain("OCX_SHIM_BYPASS");
    expect(script).toContain("& 'C:\\codex-real.ps1' @args");
  });

  test("Unix shim skips ocx startup for Codex internal commands", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
    const logPath = join(dir, "calls.log");
    const bunPath = join(dir, "bun");
    const realCodexPath = join(dir, "codex-real");
    const shimPath = join(dir, "codex");

    writeFileSync(bunPath, `#!/usr/bin/env sh\necho "bun:$*" >> "${logPath}"\n`, "utf8");
    writeFileSync(realCodexPath, `#!/usr/bin/env sh\necho "codex:$*" >> "${logPath}"\n`, "utf8");
    writeFileSync(shimPath, buildUnixCodexShim(realCodexPath, bunPath, "/opt/opencodex/src/cli.ts"), "utf8");
    chmodSync(bunPath, 0o755);
    chmodSync(realCodexPath, 0o755);
    chmodSync(shimPath, 0o755);
    const env = { ...process.env };
    delete env.OCX_SHIM_BYPASS;

    const resume = spawnSync(shimPath, ["resume", "--all"], { encoding: "utf8", env });
    expect(resume.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe("codex:resume --all\n");

    const prompt = spawnSync(shimPath, ["hello"], { encoding: "utf8", env });
    expect(prompt.status).toBe(0);
    expect(readFileSync(logPath, "utf8")).toBe(
      "codex:resume --all\nbun:/opt/opencodex/src/cli.ts ensure\ncodex:hello\n",
    );
  });

  test("Windows shim skips ocx startup for Codex internal commands", () => {
    const script = buildWindowsCodexShim("C:\\Tools\\codex-real.exe", "C:\\Bun\\bun.exe", "C:\\ocx\\cli.ts");

    expect(script).toContain('if /I "%~1"=="resume" goto run_codex');
    expect(script).toContain('if /I "%~1"=="app-server" goto run_codex');
    expect(script).toContain('if /I "%~1"=="exec" goto run_codex');
    expect(script).toContain('if /I "%~1"=="--help" goto run_codex');
  });

  test("Windows install backs up cmd and ps1 npm launchers without touching the bare launcher", () => {
    if (process.platform !== "win32") return;

    const dir = mkdtempSync(join(tmpdir(), "ocx-shim-bin-"));
    const home = mkdtempSync(join(tmpdir(), "ocx-shim-home-"));
    const oldPath = process.env.PATH;
    const oldHome = process.env.OPENCODEX_HOME;
    const cmd = join(dir, "codex.cmd");
    const ps1 = join(dir, "codex.ps1");
    const bare = join(dir, "codex");
    const cmdOriginal = "@echo off\r\necho real cmd %*\r\n";
    const ps1Original = "Write-Output 'real ps1'\n";
    const bareOriginal = "#!/bin/sh\necho bare\n";

    try {
      process.env.PATH = dir;
      process.env.OPENCODEX_HOME = home;
      writeFileSync(cmd, cmdOriginal, "utf8");
      writeFileSync(ps1, ps1Original, "utf8");
      writeFileSync(bare, bareOriginal, "utf8");

      const installed = installCodexShim();

      expect(installed.installed).toBe(true);
      expect(readFileSync(cmd, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(ps1, "utf8")).toContain(SHIM_MARKER);
      expect(readFileSync(bare, "utf8")).toBe(bareOriginal);
      expect(readFileSync(join(dir, "codex.opencodex-real.cmd"), "utf8")).toBe(cmdOriginal);
      expect(readFileSync(join(dir, "codex.opencodex-real.ps1"), "utf8")).toBe(ps1Original);

      const state = JSON.parse(readFileSync(join(home, "codex-shim.json"), "utf8"));
      expect(state.wrappers).toHaveLength(2);

      const removed = uninstallCodexShim();

      expect(removed.removed).toBe(true);
      expect(readFileSync(cmd, "utf8")).toBe(cmdOriginal);
      expect(readFileSync(ps1, "utf8")).toBe(ps1Original);
      expect(readFileSync(bare, "utf8")).toBe(bareOriginal);
    } finally {
      process.env.PATH = oldPath;
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
