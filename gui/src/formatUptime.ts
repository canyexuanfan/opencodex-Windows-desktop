import { DICTS, type Locale } from "./i18n/shared";

const FALLBACK_UNITS: Record<Locale, { day: string; hour: string; minute: string; second: string }> = {
  en: { day: "d", hour: "h", minute: "m", second: "s" },
  de: { day: "T", hour: "Std", minute: "Min", second: "Sek" },
  ko: { day: "일", hour: "시간", minute: "분", second: "초" },
  zh: { day: "天", hour: "小时", minute: "分钟", second: "秒" },
  ru: { day: "д", hour: "ч", minute: "мин", second: "с" },
  ja: { day: "日", hour: "時間", minute: "分", second: "秒" },
  tr: { day: " gün", hour: " saat", minute: " dk", second: " sn" },
};

export function formatUptime(seconds: number, locale: Locale): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const dict = DICTS[locale];
  const units = dict ? {
    day: dict["uptime.day"] ?? FALLBACK_UNITS[locale]?.day ?? "d",
    hour: dict["uptime.hour"] ?? FALLBACK_UNITS[locale]?.hour ?? "h",
    minute: dict["uptime.minute"] ?? FALLBACK_UNITS[locale]?.minute ?? "m",
    second: dict["uptime.second"] ?? FALLBACK_UNITS[locale]?.second ?? "s",
  } : (FALLBACK_UNITS[locale] ?? FALLBACK_UNITS.en);

  if (totalSeconds < 5 * 60) return `${totalSeconds}${units.second}`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}${units.minute}`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}${units.hour} ${minutes}${units.minute}` : `${totalHours}${units.hour}`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}${units.day} ${hours}${units.hour}` : `${days}${units.day}`;
}
