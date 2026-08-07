import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/tray/windows-tray.ps1"), "utf8");

describe("Windows tray restart process hardening", () => {
  test("fails a pending action when tracked process state cannot be inspected", () => {
    expect(source).toContain("pending process result inspection failed");
    expect(source).toMatch(/catch\s*\{[\s\S]*?pending process result inspection failed[\s\S]*?\$commandFailed\s*=\s*\$true[\s\S]*?\}/);
  });

  test("does not silently swallow pending-process disposal failures during live operation", () => {
    const matches = source.match(/pending process dispose failed/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toContain("try { $script:pendingProcess.Dispose() } catch { }");
  });

  test("tracks Start Proxy and Stop Proxy exit codes like Restart Proxy", () => {
    expect(source).toContain('$startProcess = Start-OcxCommand @("__tray-start") -TrackExit');
    expect(source).toContain('$script:pendingProcess = $startProcess');
    expect(source).toContain('$stopProcess = Start-OcxCommand @("stop") -TrackExit');
    expect(source).toContain('$script:pendingProcess = $stopProcess');
  });
});
