import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAllowedLoopbackUrl } from "../src/url-policy";

test("navigation allows only the active loopback origin", () => {
  expect(isAllowedLoopbackUrl("http://127.0.0.1:49152/", "http://127.0.0.1:49152")).toBe(true);
  expect(isAllowedLoopbackUrl("http://127.0.0.1:49153/", "http://127.0.0.1:49152")).toBe(false);
  expect(isAllowedLoopbackUrl("https://127.0.0.1:49152/", "http://127.0.0.1:49152")).toBe(false);
  expect(isAllowedLoopbackUrl("http://0.0.0.0:49152/", "http://0.0.0.0:49152")).toBe(false);
});

test("window.open is always denied while external HTTP links use the system browser", () => {
  const source = readFileSync(resolve(import.meta.dir, "../src/navigation.ts"), "utf8");
  expect(source).toContain("contents.setWindowOpenHandler");
  expect(source).toContain("void shell.openExternal(parsed.toString())");
  expect(source).not.toContain('return { action: "allow" }');
  expect(source).toContain('return { action: "deny" }');
});

test("navigation policy updates the active origin instead of stacking listeners per port", () => {
  const navigation = readFileSync(resolve(import.meta.dir, "../src/navigation.ts"), "utf8");
  const main = readFileSync(resolve(import.meta.dir, "../src/main.ts"), "utf8");
  expect(navigation).toContain("let activeOrigin = expectedOrigin;");
  expect(navigation).toContain("setExpectedOrigin: origin =>");
  expect(navigation).toContain('contents.removeListener("will-navigate", onWillNavigate)');
  expect(main.match(/installNavigationPolicy\(/g)?.length).toBe(1);
  expect(main).toContain("navigationPolicy?.setExpectedOrigin(new URL(url).origin)");
});
