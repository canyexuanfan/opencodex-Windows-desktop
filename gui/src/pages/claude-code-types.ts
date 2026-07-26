import type { SidecarOverride } from "./claude-manual-env";

export interface MapRow {
  id: string;
  from: string;
  to: string;
}

export interface ClaudeCodeState {
  enabled: boolean;
  authMode: "subscription" | "proxy";
  autoConnectSupported: boolean;
  systemEnv: boolean;
  fastMode: boolean | null;
  /** Legacy config override (no GUI control anymore) — still disables auto-context when hand-set. */
  maxContextTokens: number | null;
  autoContext: boolean;
  autoCompactWindow: number | null;
  injectAgents: boolean;
  smallFastModel: string;
  tierModels?: { haiku?: string };
  effectiveModelEnv: Record<string, string>;
  available: string[];
  aliases: { id: string; display_name: string }[];
  webSearchSidecar?: SidecarOverride;
  visionSidecar?: SidecarOverride;
  port: number;
}

/** Compact auto-summarize window labels (350k / 1M). Uses Intl for the million suffix. */
export function formatCompactWindow(value: number, locale = "en"): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const oneDecimal = millions.toFixed(1).replace(/\.0$/, "");
    // Exact million ladder values use locale-aware compact notation; off-ladder
    // values that would collide with "1M" keep a distinct k label.
    if (Number.isInteger(millions) || Number(oneDecimal) * 1_000_000 === value) {
      return new Intl.NumberFormat(locale, {
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: Number.isInteger(millions) ? 0 : 1,
      }).format(value);
    }
    return `${Math.round(value / 1_000)}k`;
  }
  return `${Math.round(value / 1_000)}k`;
}
