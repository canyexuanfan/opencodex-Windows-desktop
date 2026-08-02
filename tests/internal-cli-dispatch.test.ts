import { describe, expect, test } from "bun:test";
import { dispatchInternalCliCommand, type InternalCliCommand } from "../src/cli/internal-dispatch";

describe("internal CLI dispatcher", () => {
  test.each([
    ["__tray-start", "trayStart"],
    ["__tray-restart", "trayRestart"],
    ["__startup-health", "startupHealth"],
  ] as const)("routes %s to only %s", async (command, expected) => {
    const calls: string[] = [];
    await dispatchInternalCliCommand(command as InternalCliCommand, {
      trayStart: async () => { calls.push("trayStart"); },
      trayRestart: async () => { calls.push("trayRestart"); },
      startupHealth: async () => { calls.push("startupHealth"); },
    });
    expect(calls).toEqual([expected]);
  });

  test("propagates an action failure to the CLI boundary", async () => {
    await expect(dispatchInternalCliCommand("__tray-start", {
      trayStart: async () => { throw new Error("start failed"); },
      trayRestart: () => {},
      startupHealth: () => {},
    })).rejects.toThrow("start failed");
  });

  test("rejects an unknown runtime value without invoking a handler", async () => {
    const calls: string[] = [];
    await expect(dispatchInternalCliCommand("__invalid" as InternalCliCommand, {
      trayStart: () => { calls.push("trayStart"); },
      trayRestart: () => { calls.push("trayRestart"); },
      startupHealth: () => { calls.push("startupHealth"); },
    })).rejects.toThrow("Unsupported internal CLI command");
    expect(calls).toEqual([]);
  });
});
