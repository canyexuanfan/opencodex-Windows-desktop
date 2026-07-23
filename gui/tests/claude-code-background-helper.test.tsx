import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { SmallFastModelSetting } from "../src/pages/ClaudeCode";

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

const options = [
  { value: "", label: "Let Claude Code choose (native model)" },
  { value: "gemini/gemini-3-flash", label: "gemini/gemini-3-flash" },
];

function renderSetting(value: string): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <SmallFastModelSetting value={value} options={options} onChange={() => {}} />
    </LanguageProvider>,
  );
}

test("unset background helper explains native selection and Sonnet cost", () => {
  const html = renderSetting("");
  expect(html).toContain("Let Claude Code choose (native model)");
  expect(html).toContain("background work such as chat summaries and topic detection");
  expect(html).toContain("native Sonnet model");
  expect(html).toContain("may incur charges from your native provider");
  expect(html).toContain('role="note"');
});

test("selected background helper keeps the neutral description and hides the native warning", () => {
  const html = renderSetting("gemini/gemini-3-flash");
  expect(html).toContain("gemini/gemini-3-flash");
  expect(html).toContain("background work such as chat summaries and topic detection");
  expect(html).not.toContain("native Sonnet model");
  expect(html).not.toContain('role="note"');
});
