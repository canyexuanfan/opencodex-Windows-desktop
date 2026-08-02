import { expect, test } from "bun:test";
import {
  DESKTOP_HOSTNAME,
  formatDesktopReadyMessage,
  isDesktopReadyMessage,
  parseDesktopReadyLine,
} from "../src/desktop/ready";
import { startServer } from "../src/server";

const ready = {
  type: "ready" as const,
  pid: 1234,
  port: 49152,
  hostname: DESKTOP_HOSTNAME,
  version: "2.8.0",
};

test("desktop ready protocol accepts only the strict message", () => {
  const line = formatDesktopReadyMessage(ready);
  expect(parseDesktopReadyLine(line)).toEqual(ready);
  expect(isDesktopReadyMessage(ready)).toBe(true);
  expect(parseDesktopReadyLine("proxy log: ready")).toBeNull();
});

test("desktop ready protocol rejects invalid port and hostname", () => {
  expect(parseDesktopReadyLine(JSON.stringify({ ...ready, port: 0 }))).toBeNull();
  expect(parseDesktopReadyLine(JSON.stringify({ ...ready, hostname: "0.0.0.0" }))).toBeNull();
  expect(() => formatDesktopReadyMessage({ ...ready, port: 65536 })).toThrow("invalid desktop ready message");
});

test("desktop server override binds one concrete loopback port from port 0", () => {
  const server = startServer(0, { hostname: DESKTOP_HOSTNAME });
  try {
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).not.toBe(10100);
  } finally {
    server.stop(true);
  }
});

test("dynamic desktop starts do not claim 10100, do not share a port, and release on stop", async () => {
  let holder: ReturnType<typeof Bun.serve> | undefined;
  try {
    holder = Bun.serve({
      hostname: DESKTOP_HOSTNAME,
      port: 10100,
      fetch: () => new Response("holder"),
    });
  } catch {
    // Another process owns 10100 in this environment; the dynamic-port assertion below remains valid.
  }

  const first = startServer(0, { hostname: DESKTOP_HOSTNAME });
  const second = startServer(0, { hostname: DESKTOP_HOSTNAME });
  const firstPort = first.port;
  const secondPort = second.port;
  expect(firstPort).toBeGreaterThan(0);
  expect(secondPort).toBeGreaterThan(0);
  expect(firstPort).not.toBe(10100);
  expect(secondPort).not.toBe(10100);
  expect(firstPort).not.toBe(secondPort);

  first.stop(true);
  second.stop(true);
  holder?.stop(true);
  await Bun.sleep(25);
  await expect(fetch(`http://${DESKTOP_HOSTNAME}:${firstPort}/healthz`)).rejects.toThrow();
});
