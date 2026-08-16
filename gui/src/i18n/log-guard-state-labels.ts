import type { Locale } from "./catalogs";

export type LogGuardSchemaState = "compatible" | "missing" | "unreadable" | "unsupported";

const SCHEMA_LABELS: Record<Locale, Record<LogGuardSchemaState, string>> = {
  en: {
    compatible: "Compatible",
    missing: "Database not found",
    unreadable: "Database unavailable",
    unsupported: "Unsupported",
  },
  de: {
    compatible: "Kompatibel",
    missing: "Datenbank nicht gefunden",
    unreadable: "Datenbank nicht lesbar",
    unsupported: "Nicht unterstützt",
  },
  fr: {
    compatible: "Compatible",
    missing: "Base de données introuvable",
    unreadable: "Base de données indisponible",
    unsupported: "Non pris en charge",
  },
  ko: {
    compatible: "호환됨",
    missing: "데이터베이스 없음",
    unreadable: "데이터베이스를 읽을 수 없음",
    unsupported: "지원되지 않음",
  },
  zh: {
    compatible: "兼容",
    missing: "未找到数据库",
    unreadable: "无法读取数据库",
    unsupported: "不受支持",
  },
  "zh-TW": {
    compatible: "相容",
    missing: "找不到資料庫",
    unreadable: "無法讀取資料庫",
    unsupported: "不支援",
  },
  ru: {
    compatible: "Совместимо",
    missing: "База не найдена",
    unreadable: "База недоступна",
    unsupported: "Не поддерживается",
  },
  ja: {
    compatible: "互換",
    missing: "データベースが見つかりません",
    unreadable: "データベースを読み取れません",
    unsupported: "未対応",
  },
  tr: {
    compatible: "Uyumlu",
    missing: "Veritabanı bulunamadı",
    unreadable: "Veritabanı okunamıyor",
    unsupported: "Desteklenmiyor",
  },
};

export function logGuardSchemaStateLabel(locale: Locale, state: LogGuardSchemaState): string {
  return SCHEMA_LABELS[locale][state];
}
