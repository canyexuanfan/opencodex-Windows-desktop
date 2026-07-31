import { expect, test } from "bun:test";
import {
  DESKTOP_HOSTNAME,
  formatDesktopReadyMessage,
  isDesktopReadyMessage,
  parseDesktopReadyLine,
} from "../../src/desktop/ready";

const ready = {
  type: "ready" as const,
  pid: 1234,
  port: 49152,
  hostname: DESKTOP_HOSTNAME,
  version: "2.8.0",
};

test("ready protocol formats and parses the strict message", () => {
  const line = formatDesktopReadyMessage(ready);
  expect(parseDesktopReadyLine(line)).toEqual(ready);
  expect(isDesktopReadyMessage(ready)).toBe(true);
});

test("ordinary logs, duplicate-shaped payloads and invalid ports are rejected", () => {
  expect(parseDesktopReadyLine("🚀 opencodex proxy running")).toBeNull();
  expect(parseDesktopReadyLine(JSON.stringify({ ...ready, type: "log" }))).toBeNull();
  expect(parseDesktopReadyLine(JSON.stringify({ ...ready, port: 0 }))).toBeNull();
  expect(parseDesktopReadyLine(JSON.stringify({ ...ready, hostname: "0.0.0.0" }))).toBeNull();
  expect(() => formatDesktopReadyMessage({ ...ready, port: 0 })).toThrow("invalid desktop ready message");
});
