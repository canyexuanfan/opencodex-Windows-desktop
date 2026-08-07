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

  test("detectInitial detects tr from navigator language", () => {
    const origNav = globalThis.navigator;
    try {
      // @ts-expect-error test isolation mock
      globalThis.navigator = { language: "tr-TR" };
      expect(detectInitial()).toBe("tr");
    } finally {
      globalThis.navigator = origNav;
    }
  });

  test("detectInitial detects tr from stored preference", () => {
    const origStorage = globalThis.localStorage;
    try {
      const store = new Map<string, string>([["ocx-lang", "tr"]]);
      // @ts-expect-error test isolation mock
      globalThis.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      };
      expect(detectInitial()).toBe("tr");
    } finally {
      globalThis.localStorage = origStorage;
    }
  });
});
