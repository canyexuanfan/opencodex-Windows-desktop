import { expect, test } from "bun:test";

test("Subagents uses global viewMode (no per-page toggle) and workspace shell", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).toContain("viewMode");
  expect(page).toContain("readViewMode");
  expect(page).toContain("SubagentsWorkspace");
  expect(page).toContain('workspaceView = (viewMode ?? readViewMode()) === "workspace"');
  // Sidebar owns Classic/Workspace — no local ocx-subagents-view toggle on the page.
  expect(page).not.toContain("ocx-subagents-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  expect(app).toContain("<Subagents apiBase={API_BASE} viewMode={viewMode} />");
  expect(css).toContain('@import "./styles-subagents-workspace.css"');
});

test("SubagentsWorkspace exposes featured rail + save actions", async () => {
  const src = await Bun.file(
    new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url),
  ).text();
  expect(src).toContain("subagents-workspace-shell");
  expect(src).toContain("subagents-workspace-rail");
  expect(src).toContain("sub.workspace.addToFeatured");
  expect(src).toContain("sub.workspace.removeFromFeatured");
  expect(src).toContain("common.save");
  // Nested <main> is invalid inside App's main landmark.
  expect(src).toContain('<section className="subagents-workspace-main"');
  expect(src).not.toContain("<main className=\"subagents-workspace-main\"");
  // Rail toggles must include the model name in their accessible label.
  expect(src).toContain('t("sub.workspace.removeFromFeatured", { m })');
  expect(src).toContain('t("sub.workspace.addToFeatured", { m })');
  // Do not fabricate openai provider for bare combo aliases.
  expect(src).not.toContain('"openai"');
  expect(src).toContain("routedParts");
});

test("Subagents rail list reserves scrollbar gutter so toggles stay clear", async () => {
  const css = await Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url)).text();
  expect(css).toMatch(/\.subagents-workspace-rail-list\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  expect(css).toMatch(/\.subagents-workspace-rail-list\s*\{[^}]*padding-inline-end:/s);
  expect(css).toMatch(/\.subagents-workspace-rail-list\s*\{[^}]*padding-block-end:/s);
});

test("Subagents workspace stacks via content-width container query before mobile drawer", async () => {
  const css = await Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url)).text();
  expect(css).toContain("container-name: subagents-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container subagents-workspace (max-width: 720px)");
  expect(css).toContain("@media (max-width: 768px)");
});
