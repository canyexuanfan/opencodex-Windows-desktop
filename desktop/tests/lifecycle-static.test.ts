import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(import.meta.dir, "../src");

test("main process owns tray lifecycle and bounded recovery", () => {
  const main = readFileSync(resolve(src, "main.ts"), "utf8");
  expect(main).toContain("app.on(\"before-quit\"");
  expect(main).toContain("backend.stop()");
  expect(main).toContain("OpenCodex 无法安全退出");
  expect(main).toContain("代理仍保持运行");
  expect(main).toContain("Menu.setApplicationMenu(null)");
  expect(main).toContain("autoHideMenuBar: true");
  expect(main).toContain("mainWindow.setMenuBarVisibility(false)");
  expect(main).toContain('mainWindow.webContents.send("desktop:status-changed", status)');
  expect(main).toContain("function currentDashboardHash()");
  expect(main).toContain('currentUrl.hostname !== "127.0.0.1"');
  expect(main).toContain("function dashboardUrl(port: number, hash = \"\")");
  expect(main).toContain("if (hash) url.hash = hash.startsWith(\"#\") ? hash.slice(1) : hash;");
  expect(main).toContain("async function loadDashboard(port: number, hash = currentDashboardHash())");
  expect(main).toContain('document.getElementById("start")');
  expect(main).toContain("button:hover:not(:disabled)");
  expect(main).toContain("button:disabled{opacity:");
  expect(main).toContain("#start:hover:not(:disabled)");
  expect(main).toContain("recoveryAttempts >= 2");
  expect(main).toContain("render-process-gone");
  expect(main).toContain("restart: () => void restartProxy().catch(() => {})");
  const stopStart = main.indexOf("async function stopProxy");
  const restartStart = main.indexOf("async function restartProxy");
  const stopBody = main.slice(stopStart, restartStart);
  expect(stopBody).not.toContain("showOfflineState()");
  expect(stopBody).toContain("publishBackendStatus(status)");
});

test("tray exposes status and the five lifecycle actions", () => {
  const tray = readFileSync(resolve(src, "tray.ts"), "utf8");
  expect(tray).toContain("TrayStatus");
  expect(tray).toContain("actions.start");
  expect(tray).toContain("actions.stop");
  expect(tray).toContain("actions.restart");
  expect(tray).toContain('enabled: ownsLifecycle');
  expect(tray).toContain('ownership === "external"');
  expect(tray).toContain("app.quit()");
});

test("desktop sidecar restores Codex routing on stop and recovers stale routing on startup", () => {
  const entry = readFileSync(resolve(src, "..", "..", "src", "desktop", "entry.ts"), "utf8");
  expect(entry).toContain("isCodexRoutingInjected,");
  expect(entry).toContain("restoreNativeCodex,");
  expect(entry).toContain("if (state.ownsServer && state.codexRoutingOwned)");
  expect(entry).toContain("restoreCodex: restoreNativeCodex");
  expect(entry).toContain('type: "stop-refused"');
  expect(entry).toContain("shuttingDown = false");
  expect(entry).toContain("if (isCodexRoutingInjected())");
  expect(entry).toContain("const recovered = restoreNativeCodex();");
  expect(entry.indexOf("restoreCodex: restoreNativeCodex")).toBeLessThan(entry.indexOf("if (server) await drainAndShutdown"));
  expect(entry.indexOf("if (isCodexRoutingInjected())")).toBeLessThan(entry.indexOf("server = startServer"));
  expect(entry).toContain("codexRoutingOwned = !currentExternalCodexModelProvider() && isCodexRoutingInjected();");
});

test("desktop host keeps the original dashboard capability surface", () => {
  const app = readFileSync(resolve(src, "..", "..", "gui", "src", "App.tsx"), "utf8");
  const routing = readFileSync(resolve(src, "..", "..", "gui", "src", "app-routing.ts"), "utf8");
  const pageUnion = [...routing.matchAll(/^\s*\|\s*"([^"]+)"/gm)].map(match => match[1]);
  expect(pageUnion.length).toBeGreaterThan(0);
  for (const page of ["dashboard", "startup", "codex-auth", "providers", "models", "combos", "subagents", "logs", "usage", "storage", "api", "claude", "grok", ...pageUnion]) {
    expect(app).toContain(`page === "${page}"`);
  }
  const main = readFileSync(resolve(src, "main.ts"), "utf8");
  expect(main).toContain("loadDashboard(status.port)");
  expect(main).toContain("path.join(process.resourcesPath, \"opencodex\")");
});

test("desktop proxy start preserves the current hash route when switching ports", () => {
  const main = readFileSync(resolve(src, "main.ts"), "utf8");
  const startProxyStart = main.indexOf("async function startProxy");
  const stopProxyStart = main.indexOf("async function stopProxy");
  const startProxyBody = main.slice(startProxyStart, stopProxyStart);
  const loadDashboardStart = main.indexOf("async function loadDashboard");
  const showOfflineStart = main.indexOf("async function showOfflineState");
  const loadDashboardBody = main.slice(loadDashboardStart, showOfflineStart);

  expect(startProxyBody).toContain("await loadDashboard(status.port)");
  expect(loadDashboardBody).toContain("hash = currentDashboardHash()");
  expect(loadDashboardBody).toContain("dashboardUrl(port, hash)");
  expect(loadDashboardBody).not.toContain('`http://127.0.0.1:${port}/`');
});
