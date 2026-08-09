import { describe, expect, test } from "bun:test";
import { DICTS, LOCALES, LOCALE_NAMES, detectInitial } from "../src/i18n/shared";
import { en } from "../src/i18n/en";
import { tr } from "../src/i18n/tr";
import { formatUptime } from "../src/formatUptime";

describe("Turkish (tr) i18n locale", () => {
  test("registers tr in LOCALES array with correct metadata", () => {
    const trLocale = LOCALES.find(l => l.code === "tr");
    expect(trLocale).toEqual({ code: "tr", htmlLang: "tr" });
    expect("name" in (trLocale ?? {})).toBe(false);
    expect(LOCALE_NAMES.tr).toBe("Türkçe");
  });

  test("includes tr in DICTS map", () => {
    expect(DICTS.tr).toBe(tr);
  });

  test("tr dictionary covers all TKeys from source-of-truth en catalog", () => {
    const enKeys = Object.keys(en);
    const missingKeys = enKeys.filter(k => !(k in tr));
    expect(missingKeys).toEqual([]);
  });

  test("tr dictionary preserves all interpolation placeholders from en catalog", () => {
    const enKeys = Object.keys(en) as Array<keyof typeof en>;
    const placeholderRe = /\{([a-zA-Z0-9_]+)\}/g;
    const mismatched: string[] = [];

    for (const key of enKeys) {
      const enVal = en[key];
      const trVal = tr[key];
      if (typeof enVal !== "string" || typeof trVal !== "string") continue;

      const enPlaceholders = [...enVal.matchAll(placeholderRe)].map(m => m[1]).sort();
      const trPlaceholders = [...trVal.matchAll(placeholderRe)].map(m => m[1]).sort();

      if (
        enPlaceholders.length !== trPlaceholders.length ||
        enPlaceholders.some((ph, index) => ph !== trPlaceholders[index])
      ) {
        mismatched.push(`${key}: placeholder parity mismatch (en: [${enPlaceholders}], tr: [${trPlaceholders}])`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  test("tr.ts has no duplicate key declarations", async () => {
    const text = await Bun.file(new URL("../src/i18n/tr.ts", import.meta.url)).text();
    const keyRe = /^\s*"([^"]+)":/gm;
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const match of text.matchAll(keyRe)) {
      const key = match[1];
      if (seen.has(key)) {
        duplicates.push(key);
      } else {
        seen.add(key);
      }
    }

    expect(duplicates).toEqual([]);
  });

  test("formatUptime correctly formats seconds, minutes, hours, and days in Turkish", () => {
    expect(formatUptime(45, "tr")).toBe("45 sn");
    expect(formatUptime(300, "tr")).toBe("5 dk");
    expect(formatUptime(3600, "tr")).toBe("1 saat");
    expect(formatUptime(3660, "tr")).toBe("1 saat 1 dk");
    expect(formatUptime(86400, "tr")).toBe("1 gün");
    expect(formatUptime(90000, "tr")).toBe("1 gün 1 saat");
  });

  test("detectInitial detects tr from navigator language cleanly isolated from localStorage", () => {
    const origNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const origStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "navigator", {
        value: { language: "tr-TR" },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {},
        },
        configurable: true,
        writable: true,
      });
      expect(detectInitial()).toBe("tr");
    } finally {
      if (origNav) Object.defineProperty(globalThis, "navigator", origNav);
      if (origStorage) Object.defineProperty(globalThis, "localStorage", origStorage);
    }
  });

  test("detectInitial detects tr from stored preference", () => {
    const origStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      const store = new Map<string, string>([["ocx-lang", "tr"]]);
      Object.defineProperty(globalThis, "localStorage", {
        value: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        },
        configurable: true,
        writable: true,
      });
      expect(detectInitial()).toBe("tr");
    } finally {
      if (origStorage) Object.defineProperty(globalThis, "localStorage", origStorage);
    }
  });
});
