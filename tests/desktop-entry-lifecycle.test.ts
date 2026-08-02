import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatDesktopStopRefusedMessage,
  formatDesktopStoppedMessage,
  runDesktopShutdownTransaction,
} from "../src/desktop/entry";

const SOURCE = readFileSync(join(import.meta.dir, "..", "src", "desktop", "entry.ts"), "utf8");

function sliceBetween(start: string, end: string): string {
  const from = SOURCE.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = SOURCE.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return SOURCE.slice(from, to);
}

describe("desktop-owned proxy lifecycle wiring", () => {
  test("external adoption remains an Electron-only ownership decision", () => {
    const main = sliceBetween("async function main()", "if (import.meta.main)");
    expect(SOURCE).not.toContain('import { findLiveProxy } from "../server/proxy-liveness"');
    expect(main).not.toContain("findLiveProxy()");
    expect(main).not.toContain("holdTimer");
    expect(main.indexOf("reconcileJournal()")).toBeLessThan(main.indexOf("startServer(0"));
  });

  test("startup mirrors the ordinary daemon lifecycle for an owned listener", () => {
    const main = sliceBetween("async function main()", "if (import.meta.main)");

    for (const call of [
      "reconcileJournal()",
      "scheduleCatalogPrewarm()",
      "installCrashGuards()",
      "startTokenGuardian()",
      "integrationEnvironmentOwned = serviceEnvironmentOwnedHere()",
      "syncModelsToCodex(port, config)",
      "startHistoryMigrationGuardian()",
      "buildDesktop3pRegistry(",
      "syncGrokConfig(port, config, { hostname: DESKTOP_HOSTNAME })",
    ]) {
      expect(main).toContain(call);
    }

    expect(main.indexOf("scheduleCatalogPrewarm()")).toBeGreaterThan(main.indexOf("startServer(0"));
    expect(main.indexOf("scheduleCatalogPrewarm()")).toBeLessThan(main.indexOf("writePid(process.pid)"));
    expect(main.indexOf("installCrashGuards()")).toBeLessThan(main.indexOf("writePid(process.pid)"));
    expect(main.indexOf("buildDesktop3pRegistry(")).toBeLessThan(main.indexOf('await import("../grok/sync")'));
    expect(main).toContain("if (integrationEnvironmentOwned)");
    expect(main).toContain("grokRoutingOwned = result.ok && result.changed");
  });

  test("history migration and route ownership use the actual loopback desktop lease", () => {
    const main = sliceBetween("async function main()", "if (import.meta.main)");

    expect(main).toContain("const config = { ...loadConfig(), hostname: DESKTOP_HOSTNAME }");
    expect(main).toContain("codexRoutingOwned = !currentExternalCodexModelProvider() && isCodexRoutingInjected()");
    expect(main).toContain("codexRoutingOwned\n      && !shouldInjectApiAuthHeader(config)");
    expect(main).toContain("&& config.syncResumeHistory !== false");
  });

  test("accepted shutdown executes integrations, drain, runtime cleanup, then exit", async () => {
    const calls: string[] = [];
    const outcome = await runDesktopShutdownTransaction(
      { ownsServer: true, codexRoutingOwned: true, exitCode: 7 },
      {
        blockCodexSyncs: () => calls.push("block-syncs"),
        waitForCodexSyncs: async () => { calls.push("wait-syncs"); return true; },
        unblockCodexSyncs: () => calls.push("unblock-syncs"),
        restoreCodex: () => { calls.push("restore-codex"); return { success: true, message: "ok" }; },
        reportRefusal: () => calls.push("report-refusal"),
        stopBackground: () => calls.push("stop-background"),
        restoreIntegrations: () => { calls.push("restore-integrations"); return { success: true, message: "ok" }; },
        drainServer: async () => { calls.push("drain-server"); },
        cleanupRuntime: () => calls.push("cleanup-runtime"),
        confirmStop: () => calls.push("confirm-stop"),
        exit: code => calls.push(`exit-${code}`),
      },
    );

    expect(outcome).toBe("stopped");
    expect(calls).toEqual([
      "block-syncs",
      "wait-syncs",
      "restore-integrations",
      "restore-codex",
      "stop-background",
      "drain-server",
      "cleanup-runtime",
      "confirm-stop",
      "exit-7",
    ]);
  });

  test("a drain failure never emits the successful stop acknowledgement", async () => {
    const calls: string[] = [];
    await expect(runDesktopShutdownTransaction(
      { ownsServer: true, codexRoutingOwned: false, exitCode: 0 },
      {
        blockCodexSyncs: () => calls.push("block-syncs"),
        waitForCodexSyncs: async () => { calls.push("wait-syncs"); return true; },
        unblockCodexSyncs: () => calls.push("unblock-syncs"),
        restoreCodex: () => ({ success: true, message: "ok" }),
        reportRefusal: () => calls.push("report-refusal"),
        stopBackground: () => calls.push("stop-background"),
        restoreIntegrations: () => { calls.push("restore-integrations"); return { success: true, message: "ok" }; },
        drainServer: async () => { calls.push("drain-server"); throw new Error("drain failed"); },
        cleanupRuntime: () => calls.push("cleanup-runtime"),
        confirmStop: () => calls.push("confirm-stop"),
        exit: code => calls.push(`exit-${code}`),
      },
    )).rejects.toThrow("drain failed");
    expect(calls).toEqual([
      "block-syncs",
      "wait-syncs",
      "restore-integrations",
      "stop-background",
      "drain-server",
      "cleanup-runtime",
      "exit-1",
    ]);
  });
});

describe("desktop stop refusal", () => {
  test("an in-flight sync timeout reopens writes and performs no teardown", async () => {
    const calls: string[] = [];
    const outcome = await runDesktopShutdownTransaction(
      { ownsServer: true, codexRoutingOwned: true, exitCode: 0 },
      {
        blockCodexSyncs: () => calls.push("block-syncs"),
        waitForCodexSyncs: async () => { calls.push("wait-syncs"); return false; },
        unblockCodexSyncs: () => calls.push("unblock-syncs"),
        restoreCodex: () => { calls.push("restore-codex"); return { success: true, message: "ok" }; },
        reportRefusal: () => calls.push("report-refusal"),
        stopBackground: () => calls.push("stop-background"),
        restoreIntegrations: () => { calls.push("restore-integrations"); return { success: true, message: "ok" }; },
        drainServer: async () => { calls.push("drain-server"); },
        cleanupRuntime: () => calls.push("cleanup-runtime"),
        confirmStop: () => calls.push("confirm-stop"),
        exit: () => calls.push("exit"),
      },
    );

    expect(outcome).toBe("refused");
    expect(calls).toEqual(["block-syncs", "wait-syncs", "report-refusal", "unblock-syncs"]);
  });

  test("integration cleanup failure keeps every live route online", async () => {
    const calls: string[] = [];
    const outcome = await runDesktopShutdownTransaction(
      { ownsServer: true, codexRoutingOwned: true, exitCode: 0 },
      {
        blockCodexSyncs: () => calls.push("block-syncs"),
        waitForCodexSyncs: async () => { calls.push("wait-syncs"); return true; },
        unblockCodexSyncs: () => calls.push("unblock-syncs"),
        restoreCodex: () => { calls.push("restore-codex"); return { success: true, message: "ok" }; },
        reportRefusal: () => calls.push("report-refusal"),
        stopBackground: () => calls.push("stop-background"),
        restoreIntegrations: () => { calls.push("restore-integrations"); return { success: false, message: "grok conflict" }; },
        drainServer: async () => { calls.push("drain-server"); },
        cleanupRuntime: () => calls.push("cleanup-runtime"),
        confirmStop: () => calls.push("confirm-stop"),
        exit: () => calls.push("exit"),
      },
    );

    expect(outcome).toBe("refused");
    expect(calls).toEqual([
      "block-syncs",
      "wait-syncs",
      "restore-integrations",
      "report-refusal",
      "unblock-syncs",
    ]);
  });

  test("a failed restore emits one parseable line and executes no teardown action", async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const outcome = await runDesktopShutdownTransaction(
      { ownsServer: true, codexRoutingOwned: true, exitCode: 0 },
      {
        blockCodexSyncs: () => calls.push("block-syncs"),
        waitForCodexSyncs: async () => { calls.push("wait-syncs"); return true; },
        unblockCodexSyncs: () => calls.push("unblock-syncs"),
        restoreCodex: () => { calls.push("restore-codex"); return { success: false, message: "journal conflict" }; },
        reportRefusal: detail => stdout.push(formatDesktopStopRefusedMessage(detail)),
        stopBackground: () => calls.push("stop-background"),
        restoreIntegrations: () => { calls.push("restore-integrations"); return { success: true, message: "ok" }; },
        drainServer: async () => { calls.push("drain-server"); },
        cleanupRuntime: () => calls.push("cleanup-runtime"),
        confirmStop: () => calls.push("confirm-stop"),
        exit: () => calls.push("exit"),
      },
    );

    expect(outcome).toBe("refused");
    expect(calls).toEqual(["block-syncs", "wait-syncs", "restore-integrations", "restore-codex", "unblock-syncs"]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual({
      type: "stop-refused",
      error: "desktop sidecar could not complete a safe shutdown: journal conflict",
    });
    expect(JSON.parse(formatDesktopStoppedMessage())).toEqual({ type: "stopped" });
  });

  test("a thrown restore error refuses identically", async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const outcome = await runDesktopShutdownTransaction(
      { ownsServer: true, codexRoutingOwned: true, exitCode: 0 },
      {
        blockCodexSyncs: () => calls.push("block-syncs"),
        waitForCodexSyncs: async () => { calls.push("wait-syncs"); return true; },
        unblockCodexSyncs: () => calls.push("unblock-syncs"),
        restoreCodex: () => { calls.push("restore-codex"); throw new Error("disk locked"); },
        reportRefusal: detail => stdout.push(formatDesktopStopRefusedMessage(detail)),
        stopBackground: () => calls.push("stop-background"),
        restoreIntegrations: () => { calls.push("restore-integrations"); return { success: true, message: "ok" }; },
        drainServer: async () => { calls.push("drain-server"); },
        cleanupRuntime: () => calls.push("cleanup-runtime"),
        confirmStop: () => calls.push("confirm-stop"),
        exit: () => calls.push("exit"),
      },
    );

    expect(outcome).toBe("refused");
    expect(calls).toEqual(["block-syncs", "wait-syncs", "restore-integrations", "restore-codex", "unblock-syncs"]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ type: "stop-refused" });
    expect(stdout[0]).toContain("disk locked");
  });

  test("entry keeps signal handlers retryable after a refusal", () => {
    expect(SOURCE).toContain('process.on("SIGINT", () => void shutdown())');
    expect(SOURCE).toContain('process.on("SIGTERM", () => void shutdown())');
    expect(SOURCE).toContain('process.on("SIGHUP", () => void shutdown())');
    expect(SOURCE).toContain('if (outcome === "refused") shuttingDown = false');
  });
});
