import type { Locale } from "./catalogs";

export type LogGuardLabelKey = "inspectionOnly" | "externalSqliteHome" | "inspectionUnavailable";

const LABELS: Record<Locale, Record<LogGuardLabelKey, string>> = {
  en: {
    inspectionOnly: "Inspection only",
    externalSqliteHome: "External SQLite storage",
    inspectionUnavailable: "Diagnostic log inspection is unavailable.",
  },
  de: {
    inspectionOnly: "Nur Inspektion",
    externalSqliteHome: "Externer SQLite-Speicher",
    inspectionUnavailable: "Die Diagnoseprotokoll-Inspektion ist nicht verfügbar.",
  },
  fr: {
    inspectionOnly: "Inspection uniquement",
    externalSqliteHome: "Stockage SQLite externe",
    inspectionUnavailable: "L’inspection des journaux de diagnostic est indisponible.",
  },
  ko: {
    inspectionOnly: "검사 전용",
    externalSqliteHome: "외부 SQLite 저장소",
    inspectionUnavailable: "진단 로그 검사를 사용할 수 없습니다.",
  },
  zh: {
    inspectionOnly: "仅检查",
    externalSqliteHome: "外部 SQLite 存储",
    inspectionUnavailable: "诊断日志检查当前不可用。",
  },
  "zh-TW": {
    inspectionOnly: "僅檢查",
    externalSqliteHome: "外部 SQLite 儲存空間",
    inspectionUnavailable: "診斷記錄檢查目前無法使用。",
  },
  ru: {
    inspectionOnly: "Только проверка",
    externalSqliteHome: "Внешнее хранилище SQLite",
    inspectionUnavailable: "Проверка диагностических журналов недоступна.",
  },
  ja: {
    inspectionOnly: "検査のみ",
    externalSqliteHome: "外部 SQLite ストレージ",
    inspectionUnavailable: "診断ログの検査を利用できません。",
  },
  tr: {
    inspectionOnly: "Yalnızca inceleme",
    externalSqliteHome: "Harici SQLite depolaması",
    inspectionUnavailable: "Tanılama günlüğü incelemesi kullanılamıyor.",
  },
};

export function logGuardLabel(locale: Locale, key: LogGuardLabelKey): string {
  return LABELS[locale][key];
}
