import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(import.meta.dir, "../src");

test("main process owns tray lifecycle and bounded recovery", () => {
  const main = readFileSync(resolve(src, "main.ts"), "utf8");
  expect(main).toContain("app.on(\"before-quit\"");
  expect(main).toContain("backend.stop()");
  expect(main).toContain("recoveryAttempts >= 2");
  expect(main).toContain("render-process-gone");
});

test("tray exposes status and the four lifecycle actions", () => {
  const tray = readFileSync(resolve(src, "tray.ts"), "utf8");
  expect(tray).toContain("状态：在线");
  expect(tray).toContain("启动代理");
  expect(tray).toContain("停止代理");
  expect(tray).not.toContain("重启代理");
  expect(tray).toContain("退出 OpenCodex");
});
