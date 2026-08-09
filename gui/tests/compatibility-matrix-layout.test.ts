import { expect, test } from "bun:test";

async function readSources(): Promise<string> {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const routing = await Bun.file(new URL("../src/app-routing.ts", import.meta.url)).text();
  const page = await Bun.file(new URL("../src/pages/CompatibilityMatrix.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const styles = await Bun.file(new URL("../src/styles-compatibility-matrix.css", import.meta.url)).text();
  return `${app}\n${routing}\n${page}\n${css}\n${styles}`;
}

test("Compatibility Lab page is mounted from App sidebar routing", async () => {
  const src = await readSources();
  expect(src).toContain('"lab"');
  expect(src).toContain("<CompatibilityMatrix apiBase={API_BASE} />");
  expect(src).toContain("nav.lab");
  expect(src).toContain('@import "./styles-compatibility-matrix.css"');
  expect(src).toContain("lab-matrix");
  expect(src).toContain("lab-verdict-badge");
});

test("Compatibility matrix uses scrollable table layout", async () => {
  const styles = await Bun.file(new URL("../src/styles-compatibility-matrix.css", import.meta.url)).text();
  expect(styles).toContain(".lab-matrix-scroll");
  expect(styles).toContain(".lab-matrix");
  expect(styles).toContain(".lab-detail-table");
});
