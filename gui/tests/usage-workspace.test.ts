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
  expect(src).toContain('<section className="usage-workspace-main"');
  expect(src).not.toContain('<main className="usage-workspace-main"');
});

test("Usage workspace stacks via content-width container query before mobile drawer", async () => {
  const css = await Bun.file(new URL("../src/styles-usage-workspace.css", import.meta.url)).text();
  expect(css).toContain("container-name: usage-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container usage-workspace (max-width: 720px)");
  expect(css).toContain("@media (max-width: 768px)");
});
