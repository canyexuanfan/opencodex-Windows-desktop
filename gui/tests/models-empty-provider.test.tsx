import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { EmptyProviderHint } from "../src/pages/Models";

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

function renderHint(liveModels: boolean): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <EmptyProviderHint liveModels={liveModels} />
    </LanguageProvider>,
  );
}

test("empty live-discovery provider renders endpoint guidance and a settings link", () => {
  const html = renderHint(true);
  expect(html).toContain("No models were discovered");
  expect(html).toContain('href="#providers"');
  expect(html).toContain("Open provider settings");
});

test("empty static provider explains that live discovery is disabled", () => {
  const html = renderHint(false);
  expect(html).toContain("Live model discovery is off");
  expect(html).toContain('role="status"');
});
