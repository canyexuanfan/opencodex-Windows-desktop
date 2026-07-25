import { expect, test } from "bun:test";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS } from "../src/startup-health-ui";

test("project-config diagnostics poll cadence is owned by the shared constant", () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
});

test("Dashboard wires a single project-config diagnostics owner outside the settings poll", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  // Diagnostics live in their own fetcher + client-resource poll, not inside core health.
  expect(core.match(/diagnostics\/project-config/g)?.length ?? 0).toBe(1);
  expect(hook).toContain("fetchProjectConfigDiagnostics");
  expect(hook).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  // Core poll must not own the diagnostics endpoint.
  const coreFnStart = core.indexOf("export async function fetchDashboardCore");
  expect(coreFnStart).toBeGreaterThan(-1);
  const coreBody = core.slice(coreFnStart);
  expect(coreBody).not.toContain("diagnostics/project-config");
});

test("Dashboard workspace pane is a labelled section, not a nested main landmark", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("dashboard-workspace-main");
  expect(src).toContain("dash.workspace.sections");
  expect(src).not.toMatch(/<main\b[^>]*dashboard-workspace-main/);
  expect(src).toMatch(/<(section)\b[^>]*dashboard-workspace-main/);
});

test("multi-agent guidance gates injection controls and Active badge on the enabled flag", async () => {
  const src = await Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text();
  expect(src).toContain("!multiAgentGuidanceEnabled");
  expect(src).toContain("multiAgentGuidanceEnabled &&");
  expect(src).toContain("models.v2Mode_");
});
