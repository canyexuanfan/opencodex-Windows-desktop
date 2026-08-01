import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../src");

test("Electron shell keeps the security baseline explicit", () => {
  const main = readFileSync(resolve(sourceRoot, "main.ts"), "utf8");
  expect(main).toContain("nodeIntegration: false");
  expect(main).toContain("contextIsolation: true");
  expect(main).toContain("sandbox: true");
  expect(main).toContain("requestSingleInstanceLock");
  expect(main).toContain("show: false");
});

test("preload exposes only fixed lifecycle channels", () => {
  const preload = readFileSync(resolve(sourceRoot, "preload.cts"), "utf8");
  expect(preload).toContain("contextBridge.exposeInMainWorld");
  expect(preload).toContain("desktop:get-status");
  expect(preload).not.toContain("execute");
  expect(preload).not.toContain("readFile");
});

test("sandbox preload points at the CommonJS build output", () => {
  const main = readFileSync(resolve(sourceRoot, "main.ts"), "utf8");
  expect(main).toContain('preload: path.join(import.meta.dirname, "preload.cjs")');
  expect(main).not.toContain('preload: path.join(import.meta.dirname, "preload.js")');
});
