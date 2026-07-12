import { useEffect, useState, type ReactNode } from "react";
import { DICTS, I18nContext, LOCALES, detectInitial, interpolate, type TFn, type TKey, type Vars } from "./shared";
import { en } from "./en";
import { useI18n } from "./shared";

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(detectInitial);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("ocx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  const t: TFn = (key, vars) => interpolate(DICTS[locale][key] ?? en[key] ?? key, vars);

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
