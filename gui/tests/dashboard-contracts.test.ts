import { expect, test } from "bun:test";

test("Dashboard owns project-config diagnostics on a single path", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  const matches = src.match(/diagnostics\/project-config/g) ?? [];
  expect(matches.length).toBe(1);
  expect(src).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  expect(src).toContain("setInterval(() => void fetchDiagnostics(), PROJECT_CONFIG_DIAGNOSTICS_POLL_MS)");
  // Ensure the five-second poll body does not also call the diagnostics endpoint.
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
  expect(src).not.toMatch(/<main className="dashboard-workspace-main"/);
});

test("multi-agent guidance disables injection controls when off", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("disabled={injectionSaving || !multiAgentGuidanceEnabled}");
  expect(src).toContain("injectionModel && multiAgentGuidanceEnabled &&");
  expect(src).toContain("t(`models.v2Mode_${mode}` as TKey)");
});
