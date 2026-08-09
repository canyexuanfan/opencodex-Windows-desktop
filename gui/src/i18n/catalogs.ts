import { en, type TKey } from "./en";
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";
import { ru } from "./ru";
import { ja } from "./ja";
import { tr } from "./tr";

/** React-free locale catalog registry for formatters and other shared helpers. */
export type Locale = "en" | "de" | "ko" | "zh" | "ru" | "ja" | "tr";

export const DICTS: Record<Locale, Record<TKey, string>> = { en, de, ko, zh, ru, ja, tr };

/** Native language names shown by the language picker, kept inside i18n rather than UI metadata. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  ko: "한국어",
  zh: "中文",
  ru: "Русский",
  ja: "日本語",
  tr: "Türkçe",
};

export function catalogValue(locale: Locale, key: TKey): string {
  return DICTS[locale][key];
}

export type { TKey };
