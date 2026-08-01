import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DesktopBackendSupervisor, loopbackProbeHostname } from "../src/backend-supervisor";

test("external reuse accepts only addresses the desktop can load through 127.0.0.1", () => {
  expect(loopbackProbeHostname(undefined)).toBe("127.0.0.1");
  expect(loopbackProbeHostname("localhost")).toBe("127.0.0.1");
  expect(loopbackProbeHostname("0.0.0.0")).toBe("127.0.0.1");
  expect(loopbackProbeHostname("192.168.1.20")).toBeNull();
  expect(loopbackProbeHostname("::1")).toBeNull();
});

test("adopts a healthy external proxy without spawning a bundled sidecar", async () => {
  let probes = 0;
  const supervisor = new DesktopBackendSupervisor({
    findExternalBackend: async () => {
      probes += 1;
      return { pid: 4242, port: 37692 };
    },
    externalProbeIntervalMs: 10,
    bunExecutable: "this-must-never-spawn.exe",
  });

  expect(await supervisor.start()).toEqual({
    state: "ready",
    pid: 4242,
    port: 37692,
    ownership: "external",
  });
  expect(probes).toBe(1);
  expect(await supervisor.stop()).toEqual({ state: "stopped" });
});

test("external proxy liveness loss is surfaced so the host can recover", async () => {
  let healthy = true;
  const states: string[] = [];
  const supervisor = new DesktopBackendSupervisor({
    findExternalBackend: async () => healthy ? { pid: 5151, port: 48123 } : null,
    externalProbeIntervalMs: 5,
  });
  supervisor.onStatusChange(status => states.push(status.state));

  await supervisor.start();
  healthy = false;
  const deadline = Date.now() + 500;
  while (supervisor.getStatus().state !== "failed" && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  expect(supervisor.getStatus()).toEqual({
    state: "failed",
    error: "external proxy is no longer healthy",
  });
  expect(states).toContain("failed");
  await supervisor.stop();
});

test("owned sidecar stop requires an explicit acknowledgement and exit code zero", async () => {
  const supervisor = new DesktopBackendSupervisor({
    findExternalBackend: async () => null,
    bunExecutable: process.execPath,
    sidecarEntry: resolve(import.meta.dir, "fixtures/backend-graceful-sidecar.ts"),
  });

  expect((await supervisor.start()).state).toBe("ready");
  expect(await supervisor.stop()).toEqual({ state: "stopped" });
}, 30_000);

test("owned sidecar exit without acknowledgement is never reported as a safe stop", async () => {
  const supervisor = new DesktopBackendSupervisor({
    findExternalBackend: async () => null,
    bunExecutable: process.execPath,
    sidecarEntry: resolve(import.meta.dir, "fixtures/backend-crash-sidecar.ts"),
  });

  expect((await supervisor.start()).state).toBe("ready");
  await expect(supervisor.stop()).rejects.toThrow("without a successful stop acknowledgement");
  expect(supervisor.getStatus().state).toBe("failed");
}, 30_000);
