import { describe, expect, test } from "bun:test";
import { runTrayProxyRestart, runTrayProxyStart, type TrayProxyStartIo } from "../src/cli/tray-proxy";

function startIo(overrides: Partial<TrayProxyStartIo> = {}) {
  const calls: string[] = [];
  const io: TrayProxyStartIo = {
    findLive: async () => null,
    diagnoseService: () => ({ installed: false, startable: false, summary: "not installed" }),
    startService: async () => { calls.push("service"); },
    startDirect: () => { calls.push("direct"); },
    waitForProxy: async () => ({ port: 10100 }),
    info: message => { calls.push(`info:${message}`); },
    error: message => { calls.push(`error:${message}`); },
    ...overrides,
  };
  return { io, calls };
}

describe("tray proxy coordinator", () => {
  test("returns immediately when a proxy is already live", async () => {
    const { io, calls } = startIo({ findLive: async () => ({ port: 20200 }) });
    expect(await runTrayProxyStart(io)).toBe(true);
    expect(calls).toEqual(["info:Proxy already running on port 20200."]);
  });

  test("refuses an installed but unviable service instead of bypassing it", async () => {
    const { io, calls } = startIo({
      diagnoseService: () => ({ installed: true, startable: false, summary: "stale" }),
    });
    expect(await runTrayProxyStart(io)).toBe(false);
    expect(calls.some(call => call.startsWith("error:Cannot start"))).toBe(true);
    expect(calls).not.toContain("direct");
    expect(calls).not.toContain("service");
  });

  test("uses a viable service and otherwise falls back to a direct start", async () => {
    const service = startIo({
      diagnoseService: () => ({ installed: true, startable: true, summary: "healthy" }),
    });
    expect(await runTrayProxyStart(service.io)).toBe(true);
    expect(service.calls).toContain("service");
    expect(service.calls).not.toContain("direct");

    const direct = startIo();
    expect(await runTrayProxyStart(direct.io)).toBe(true);
    expect(direct.calls).toContain("direct");
    expect(direct.calls).not.toContain("service");
  });

  test("fails when the selected start path never becomes healthy", async () => {
    const { io, calls } = startIo({ waitForProxy: async () => null });
    expect(await runTrayProxyStart(io)).toBe(false);
    expect(calls).toContain("direct");
    expect(calls.some(call => call.includes("did not become healthy"))).toBe(true);
  });

  test("propagates the selected start failure without trying an alternate path", async () => {
    const service = startIo({
      diagnoseService: () => ({ installed: true, startable: true, summary: "healthy" }),
      startService: async () => { service.calls.push("service"); throw new Error("service failed"); },
    });
    await expect(runTrayProxyStart(service.io)).rejects.toThrow("service failed");
    expect(service.calls).toContain("service");
    expect(service.calls).not.toContain("direct");

    const direct = startIo({
      startDirect: () => { direct.calls.push("direct"); throw new Error("spawn failed"); },
    });
    await expect(runTrayProxyStart(direct.io)).rejects.toThrow("spawn failed");
    expect(direct.calls).toContain("direct");
    expect(direct.calls).not.toContain("service");
  });

  test("restart never starts after a failed stop", async () => {
    const calls: string[] = [];
    expect(await runTrayProxyRestart({
      stop: async () => { calls.push("stop"); return false; },
      start: async () => { calls.push("start"); return true; },
    })).toBe(false);
    expect(calls).toEqual(["stop"]);

    expect(await runTrayProxyRestart({
      stop: async () => true,
      start: async () => { calls.push("start-after-stop"); return true; },
    })).toBe(true);
    expect(calls).toContain("start-after-stop");
  });
});
