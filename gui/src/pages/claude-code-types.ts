import type { SidecarOverride } from "./claude-manual-env";

export interface MapRow {
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

export function formatCompactWindow(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const label = Number.isInteger(millions) ? String(millions) : millions.toFixed(1).replace(/\.0$/, "");
    return `${label}M`;
  }
  return `${Math.round(value / 1_000)}k`;
}
