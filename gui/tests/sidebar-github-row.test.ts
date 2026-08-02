import { describe, expect, test } from "bun:test";

describe("Sidebar GitHub row", () => {
  test("star and update orbs stay collapsed until the row is hovered or focused", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
    const row = await Bun.file(new URL("../src/components/sidebar-github-row.tsx", import.meta.url)).text();

    expect(row).toContain("className=\"sidebar-github-actions\"");
    expect(row).toContain("title={starLabel}");
    expect(row).toContain("aria-label={starLabel}");
    expect(row).toContain("title={updateLabel}");
    expect(row).toContain("aria-label={updateLabel}");

    expect(css).toContain(".sidebar-github-actions");
    expect(css).toContain("width: 0;");
    expect(css).toContain("opacity: 0;");
    expect(css).toContain("pointer-events: none;");
    expect(css).toContain(".sidebar-github-row:hover .sidebar-github-actions");
    expect(css).toContain(".sidebar-github-row:focus-within .sidebar-github-actions");
    expect(css).toContain("width: 60px;");
    expect(css).toContain("pointer-events: auto;");
  });
});
