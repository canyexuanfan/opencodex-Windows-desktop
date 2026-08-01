import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(import.meta.dir, "../src");
const css = [
  "styles.css",
  "styles/provider-catalog.css",
  "styles/provider-workspace-shell.css",
  "styles-combos-workspace.css",
].map(file => readFileSync(resolve(src, file), "utf8")).join("\n");

test("audited interactive controls retain hover and keyboard-focus selectors", () => {
  for (const selector of [
    ".input:hover:not(:disabled)", ".input:focus-visible", ".switch:hover:not(:disabled)",
    ".toggle:hover:not(:disabled)", ".link-btn:hover:not(:disabled)", ".log-detail-btn:hover",
    ".usage-segmented-btn:hover:not(:disabled)", ".ocx-group-toggle:hover",
    ".provider-catalog-tab:hover", ".pws-filter-btn:hover", ".pws-sort-btn:hover",
    ".pws-model-expand:hover", ".cwi-copy-chip:hover",
  ]) expect(css).toContain(selector);
});

test("all three audited tab groups use the shared roving keyboard helper", () => {
  for (const file of [
    "components/section-tabs.tsx",
    "components/provider-catalog/ProviderCatalog.tsx",
    "components/combo-workspace-detail-panel.tsx",
  ]) {
    const source = readFileSync(resolve(src, file), "utf8");
    expect(source).toContain("handleRovingTabKey");
    expect(source).toContain("tabIndex=");
    expect(source).toContain("onKeyDown=");
  }
});
