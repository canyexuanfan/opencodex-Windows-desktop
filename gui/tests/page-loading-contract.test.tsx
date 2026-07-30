import { expect, test } from "bun:test";

/**
 * WP3 (devlog/_plan/260730_gui_hydration_loading_unify/020_page_migration.md).
 *
 * Every migrated surface answers the same three questions the same way: replace the content
 * while cold, report progress next to content that is already on screen, and keep a failure
 * distinguishable from an empty result. These are source-level pins — the behavioural proof for
 * the contract itself lives in data-surface.test.tsx.
 *
 * Each surface is added here by its own migration commit, so the list doubles as the progress
 * ledger for WP3.
 */

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/** Surfaces migrated so far, in migration order. */
const MIGRATED = [
  { name: "Grok", file: "../src/pages/Grok.tsx" },
] as const;

test("every migrated surface subscribes through the shared resource layer", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("useDataSurface");
  }
});

test("no migrated surface defers its mount fetch behind a zero-delay timer", async () => {
  // The retired pattern cancelled the timer in cleanup, so a route change during the first tick
  // dropped the request with no retry and the tab simply stayed empty.
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).not.toContain("setTimeout(() => { void load(); }, 0)");
  }
});

test("every migrated surface renders the shared cold skeleton", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("DataSurfaceSkeleton");
    expect(source, surface.name).toContain("showSkeleton");
  }
});

test("every migrated surface reports a revalidation over existing content", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("DataSurfaceStatus");
    expect(source, surface.name).toContain("state.refreshing");
  }
});

test("a failure after a success stays visible instead of reading as settled", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("state.showError");
  }
});

test("the status line yields its live region to an error notice", async () => {
  // One announcement per transition: two live regions make a screen reader repeat itself.
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("live={!state.showError}");
  }
});
