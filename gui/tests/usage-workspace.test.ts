import { expect, test } from "bun:test";

test("Usage uses global viewMode (no per-page toggle) and workspace shell", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).toContain("viewMode");
  expect(page).toContain("readViewMode");
  expect(page).toContain("UsageWorkspaceBody");
  expect(page).toContain('workspaceView = (viewMode ?? readViewMode()) === "workspace"');
  expect(page).not.toContain("ocx-usage-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  expect(app).toContain("<Usage apiBase={API_BASE} viewMode={viewMode} />");
  expect(css).toContain('@import "./styles-usage-workspace.css"');
});

test("Usage workspace uses section landmark and section rail", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  expect(src).toContain("usage-workspace-shell");
  expect(src).toContain("usage-workspace-rail");
  expect(src).toContain('t("usage.section.overview")');
  expect(src).toContain('t("usage.section.models")');
  expect(src).toContain('t("usage.section.providers")');
  expect(src).toContain('t("usage.section.coverage")');
  expect(src).toContain('<aside className="usage-workspace-rail"');
  expect(src).toContain('<section className="usage-workspace-main"');
  expect(src).not.toContain('<main className="usage-workspace-main"');
});

test("Usage workspace section titles use real headings", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  expect(src).toContain('<h3 id={titleId} className="h-section">{title}</h3>');
  expect(src).not.toContain('<div id={titleId} className="h-section">');
});

test("Usage workspace rail and report pane use distinct localized landmark names", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;

  expect(src).toContain('aria-label={t("usage.workspace.sections")}');
  expect(src).toContain('aria-label={t("usage.workspace.report")}');
  expect(src).not.toContain('aria-label={t("usage.workspace.mainAria")}');

  const railKey = 't("usage.workspace.sections")';
  const reportKey = 't("usage.workspace.report")';
  expect(railKey).not.toBe(reportKey);

  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"usage.workspace.sections":');
    expect(dict).toContain('"usage.workspace.report":');
    expect(dict).not.toContain('"usage.workspace.mainAria":');
  }

  const en = await Bun.file(new URL("../src/i18n/en.ts", import.meta.url)).text();
  expect(en).toContain('"usage.workspace.sections": "Usage sections"');
  expect(en).toContain('"usage.workspace.report": "Usage report"');
});

test("Usage workspace shell mounts before data arrives (no classic loading flash)", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  // Workspace branch must win over classic EmptyState loading/empty gates.
  const workspaceBranch = src.indexOf(") : workspaceView ? (");
  const classicLoading = src.indexOf(") : loading && !data ? (");
  expect(workspaceBranch).toBeGreaterThan(-1);
  expect(classicLoading).toBeGreaterThan(workspaceBranch);
  expect(src).toContain("loading={loading}");
  expect(src).toContain("data: UsageResponse | null");
});

test("Usage workspace stacks via content-width container query before mobile drawer", async () => {
  const css = await Bun.file(new URL("../src/styles-usage-workspace.css", import.meta.url)).text();
  expect(css).toContain("container-name: usage-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container usage-workspace (max-width: 720px)");
  expect(css).toContain("@media (max-width: 768px)");
  expect(css).toContain("Keep @container and @media stacking rules in sync");
});
