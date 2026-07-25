import { expect, test } from "bun:test";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS } from "../src/startup-health-ui";

test("Dashboard owns project-config diagnostics on a dedicated poll interval", async () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  // Single endpoint owner: the dedicated diagnostics effect, not the five-second settings poll.
  expect(src.match(/diagnostics\/project-config/g)?.length ?? 0).toBe(1);
  expect(src).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  const fetchDataStart = src.indexOf("const fetchData = async () => {");
  const fetchDataEnd = src.indexOf("const interval = setInterval(fetchData, 5000);", fetchDataStart);
  expect(fetchDataStart).toBeGreaterThan(-1);
  expect(fetchDataEnd).toBeGreaterThan(fetchDataStart);
  expect(src.slice(fetchDataStart, fetchDataEnd)).not.toContain("diagnostics/project-config");
});

test("Dashboard workspace uses a labelled section instead of nested main", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain('className="dashboard-workspace-main"');
  expect(src).toContain("aria-label={selected.label}");
  expect(src).toContain('aria-label={t("dash.workspace.sections")}');
  expect(src).not.toMatch(/<main\b[^>]*dashboard-workspace-main/);
});

test("multi-agent guidance disables injection controls when off", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("disabled={injectionSaving || !multiAgentGuidanceEnabled}");
  expect(src).toContain("injectionModel && multiAgentGuidanceEnabled &&");
  expect(src).toContain("t(`models.v2Mode_${mode}` as TKey)");
});
