import { describe, expect, test } from "bun:test";
import { DICTS, LOCALES, detectInitial } from "../src/i18n/shared";
import { en } from "../src/i18n/en";
import { tr } from "../src/i18n/tr";

describe("Turkish (tr) i18n locale", () => {
  test("registers tr in LOCALES array with correct metadata", () => {
    const trLocale = LOCALES.find(l => l.code === "tr");
    expect(trLocale).toBeDefined();
    expect(trLocale?.name).toBe("Türkçe");
    expect(trLocale?.htmlLang).toBe("tr");
  });

  test("includes tr in DICTS map", () => {
    expect(DICTS.tr).toBe(tr);
  });

  test("tr dictionary covers all TKeys from source-of-truth en catalog", () => {
    const enKeys = Object.keys(en);
    const missingKeys = enKeys.filter(k => !(k in tr));
    expect(missingKeys).toEqual([]);
  });

  test("detectInitial handles locale fallback cleanly", () => {
    const initial = detectInitial();
    expect(initial).toBeDefined();
    expect(typeof initial).toBe("string");
  });
});
