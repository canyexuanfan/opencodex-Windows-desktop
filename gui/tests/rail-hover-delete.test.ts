import { expect, test } from "bun:test";

/**
 * WP4 (devlog/_plan/260725_gui_view_consolidation/040_rail_hover_delete.md):
 * hovering a provider row in the Providers rail reveals mouse-only accelerators.
 *
 * The row itself is a <button role="option">, so the controls must be SIBLINGS inside a
 * positioned wrapper. Nesting them would be invalid HTML, would let one click both select
 * and delete, and would break the listbox's `el.contains(active)` focus tracking.
 */

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

test("the hover controls are siblings of the row, never children", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");
  const rail = await read("../src/components/provider-workspace/ProviderRail.tsx");

  expect(shell).toContain('className="pws-rail-row-wrap"');
  expect(shell).toContain("pws-rail-row-actions");
  expect(shell).toContain('pws-rail-row-actions--default');
  expect(shell).toContain('className="pwi-default-star"');
  expect(shell).toContain('className="pws-rail-row-remove"');

  expect(rail).not.toContain("pws-rail-row-remove");
  expect(rail).not.toContain("pwi-default-star");
  expect(rail).toContain('role="option"');

  expect(shell).toContain("event.stopPropagation();");
});

test("the accelerator group stays out of the tab order and accessibility tree", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");
  const removeButton = shell.slice(
    shell.indexOf('className="pws-rail-row-remove"'),
    shell.indexOf("</button>", shell.indexOf('className="pws-rail-row-remove"')),
  );

  expect(shell).toContain('aria-hidden="true"');
  expect(removeButton).toContain("tabIndex={-1}");
});

test("deleting routes through the existing confirmation dialog", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");
  const providers = await read("../src/pages/Providers.tsx");
  const crud = await read("../src/pages/use-providers-crud.ts");
  const modals = await read("../src/pages/providers-page-modals.tsx");

  expect(providers).toContain("onRemoveProvider={removeProvider}");
  expect(shell).toContain("onRemoveProvider(item.name)");

  const handler = crud.slice(
    crud.indexOf("const removeProvider = useCallback"),
    crud.indexOf("const confirmRemoveProvider"),
  );
  expect(handler).toContain("setRemoveConfirmName(name)");
  expect(handler).not.toContain("method: \"DELETE\"");
  expect(modals).toContain("<RemoveConfirmDialog");
});

test("non-default accelerators are hidden until hover while the default marker stays visible", async () => {
  const css = await read("../src/styles/provider-workspace-shell.css");
  const rule = (selector: string) => css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));

  expect(css).toContain(".pws-rail-row-wrap {");
  expect(css).toContain("position: relative;");
  expect(css).toContain(".pws-rail-row-wrap:hover .pws-rail-row-actions");
  expect(css).toContain(".pws-rail-row-wrap:focus-within .pws-rail-row-actions");
  expect(rule(".pws-rail-row-actions {")).toContain("opacity: 0;");
  expect(rule(".pws-rail-row-actions {")).toContain("pointer-events: none;");
  expect(rule(".pws-rail-row-actions--default {")).toContain("opacity: 1;");
  expect(rule(".pws-rail-row-actions--default .pws-rail-row-remove {")).toContain("width: 0;");
  expect(rule(".pws-rail-row-actions--default .pws-rail-row-remove {")).toContain("opacity: 0;");
  expect(rule(".pws-rail-row-wrap:hover .pws-rail-row-actions")).toContain("opacity: 1;");
  expect(rule(".pws-rail-row-wrap:hover .pws-rail-row-actions .pws-rail-row-remove")).toContain("width: 24px;");
  expect(rule(".pws-rail-row-wrap:hover .pws-rail-row-actions .pws-rail-row-remove")).toContain("opacity: 1;");
  expect(rule(".pwi-default-star {")).toContain("color: var(--amber);");

  expect(css).toContain("@media (hover: none)");
  expect(css.slice(css.indexOf("@media (hover: none)"))).toContain("display: none;");
});

test("the default marker sits before the delete accelerator in the hover action group", async () => {
  const shell = await read("../src/components/provider-workspace/ProviderWorkspaceShell.tsx");

  expect(shell.indexOf("pwi-default-star")).toBeGreaterThanOrEqual(0);
  expect(shell.indexOf("pws-rail-row-remove")).toBeGreaterThanOrEqual(0);
  expect(shell.indexOf("pwi-default-star")).toBeLessThan(shell.indexOf("pws-rail-row-remove"));
});
