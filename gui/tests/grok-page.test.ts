import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "ja", "ko", "ru", "zh"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

// The page is READ-ONLY by design: injectGrokConfig owns every mutation of
// ~/.grok/config.toml behind guards a web-reachable writer would widen the blast radius of.
// If a future edit adds a write control here, this test should fail and force that decision
// back through review.
test("the Grok page issues no write requests", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("/api/grok");
  for (const verb of ['method: "POST"', 'method: "PUT"', 'method: "DELETE"', 'method: "PATCH"']) {
    expect(`Grok.tsx contains ${verb}: ${page.includes(verb)}`).toBe(`Grok.tsx contains ${verb}: false`);
  }
});

// UX-STATE-01: absent is a normal state, not a failure — it must name the next action rather
// than rendering an empty panel, and the error state must offer a way out.
test("the Grok page covers loading, absent and error states", async () => {
  const page = await read("../src/pages/Grok.tsx");
  expect(page).toContain("grok.loading");
  expect(page).toContain("grok.notConfiguredTitle");
  expect(page).toContain("grok.notConfiguredHint");
  expect(page).toContain("common.retry");
});

test("the Grok page is routable and present in the nav", async () => {
  const routing = await read("../src/app-routing.ts");
  const app = await read("../src/App.tsx");
  expect(routing).toContain('| "grok"');
  expect(routing).toContain('"grok",');
  expect(app).toContain('{page === "grok" && <Grok apiBase={API_BASE} />}');
  expect(app).toContain('{ id: "grok", tkey: "nav.grok"');
});

test("every locale carries the Grok keys", async () => {
  const keys = ["nav.grok", "grok.title", "grok.subtitle", "grok.loading", "grok.loadFail",
    "grok.notConfiguredTitle", "grok.notConfiguredHint", "grok.endpoint",
    "grok.colModel", "grok.colAlias", "grok.colContext"];
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dict = await read(`../src/i18n/${locale}.ts`);
    for (const key of keys) {
      const match = new RegExp(`"${key.replace(".", "\\.")}":\\s*"([^"]+)"`).exec(dict);
      if (!match) missing.push(`${locale}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});
