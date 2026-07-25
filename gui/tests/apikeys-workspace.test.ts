import { expect, test } from "bun:test";

test("ApiKeys renders the single workspace shell (WP5 removed the layout toggle)", async () => {
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).toContain("ApiKeysWorkspace");
  expect(page).not.toContain("workspaceView");
  expect(page).not.toContain("ocx-apikeys-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  expect(app).toContain("<ApiKeys apiBase={API_BASE} />");
  expect(css).toContain('@import "./styles-apikeys-workspace.css"');
});

test("ApiKeys workspace avoids nested main and stacks via container query", async () => {
  const src = await Bun.file(new URL("../src/components/apikeys-workspace/ApiKeysWorkspace.tsx", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/ApiKeys.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles-apikeys-workspace.css", import.meta.url)).text();

  expect(src).toContain('<section className="apikeys-workspace-main"');
  expect(src).not.toContain('<main className="apikeys-workspace-main"');
  expect(src).toContain('t("api.workspace.overview")');
  expect(src).toContain('t("api.workspace.details")');
  expect(src).toContain("if (creating || createInFlight.current) return");
  expect(src).toContain("Promise<boolean>");
  expect(src).toContain("e.nativeEvent.isComposing");
  expect(page).toContain("creatingRef");
  expect(page).toContain("if (creatingRef.current) return false");

  expect(css).toContain("container-name: apikeys-workspace");
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container apikeys-workspace (max-width: 720px)");
  expect(css).toContain("@media (max-width: 768px)");
  expect(css).toContain("overflow-wrap: anywhere");
  expect(css).not.toContain("word-break: break-word");
});
