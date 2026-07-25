import { expect, test } from "bun:test";

test("App sidebar hides Codex Auth only in workspace view", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  expect(src).toContain('NAV.filter(({ id }) => !(viewMode === "workspace" && id === "codex-auth"))');
  // Page remains routable for Providers deep links.
  expect(src).toContain('{page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}');
  expect(src).toContain('{ id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey }');
});
