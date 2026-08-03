/**
 * One row model for every client the Integrations page can reach.
 *
 * The overview used to read a single route, `/api/client-integrations`, which
 * answers only for the six file-toggle clients. A user with Claude Code
 * connected and a Grok fence written was told "applied: 0" while three
 * integrations were live one tab away. Five more sources join the grid here,
 * each with its own payload shape, mapped to the badge vocabulary the file
 * clients already established.
 *
 * `unknown` is the state that keeps this honest: an unsettled or failed source
 * is NOT "not applied", and it is counted in neither summary number.
 */

import type { TKey } from "../../i18n/shared";
import type { VisualIntegrationState } from "./IntegrationStateBadge";
import {
  FILE_INTEGRATION_CLIENTS,
  type FileIntegrationClientId,
  type IntegrationStatus,
} from "./integration-api";

export type OverviewClientId =
  | "codex"
  | "keys"
  | "claude"
  | "claudeDesktop"
  | "grok"
  | FileIntegrationClientId;

export interface OverviewRow {
  id: OverviewClientId;
  /** Tab this card opens. Claude Desktop opens Claude's nested route. */
  hash: string;
  labelKey: TKey;
  state: VisualIntegrationState;
  /** Detected on this machine — drives the "detected" summary count. */
  installed: boolean;
  /** Drives the "applied" summary count. */
  applied: boolean;
  /**
   * The one line under the title. File clients show their config path — the
   * thing a user copies when a refusal tells them to finish by hand. The other
   * five have no path, so they carry the single fact that explains their badge;
   * `detailKey` is translated by the card, `detail` is already-literal text.
   */
  detail: string | null;
  detailKey: TKey | null;
  detailVars: Record<string, string> | null;
  /** Only file clients carry an inline switch; the rest are navigation only. */
  toggle: FileIntegrationClientId | null;
  /** Set only for a file client whose live status is still needed by the card. */
  status: IntegrationStatus | null;
}

/** Minimal reads. Each route returns far more than the overview needs. */
export interface CodexRoutingPayload {
  routingInjected?: boolean;
  status?: string;
  recommendedCommand?: string | null;
}
export interface ClaudeCodePayload {
  enabled?: boolean;
  authMode?: string;
}
export interface ClaudeDesktopPayload {
  applied?: boolean;
  stale?: boolean;
  activeProfile?: boolean | null;
  appliedAt?: string | null;
}
export interface GrokPayload {
  present?: boolean;
  models?: unknown[];
}

export interface OverviewSources {
  /** File-client rows; an empty array means the list has not settled. */
  clients: readonly IntegrationStatus[];
  clientsSettled: boolean;
  codex: CodexRoutingPayload | null;
  keyCount: number | null;
  claude: ClaudeCodePayload | null;
  claudeDesktop: ClaudeDesktopPayload | null;
  grok: GrokPayload | null;
}

const FILE_LABEL_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.tab.opencode",
  pi: "integrations.tab.pi",
  hermes: "integrations.tab.hermes",
  openclaw: "integrations.tab.openclaw",
  kimi: "integrations.tab.kimi",
  gajae: "integrations.tab.gajae",
};

/** A file client's block is in the file for both `current` and `stale`. */
export function isAppliedState(state: VisualIntegrationState): boolean {
  return state === "current" || state === "stale";
}

/**
 * Codex CLI.
 *
 * `routingInjected` — server-derived as `routingKind === "opencodex-local"` —
 * is the only field that answers "is opencodex in Codex's path right now".
 * `status` mixes in service viability and reboot safety, which is the Startup
 * page's question, so a `protected` status with no injected routing still
 * reads as not applied here.
 */
function codexRow(payload: CodexRoutingPayload | null): OverviewRow {
  const base = {
    id: "codex" as const,
    hash: "integrations/codex",
    labelKey: "integrations.tab.codex" as TKey,
    toggle: null,
    status: null,
    detail: null,
    detailVars: null,
  };
  if (!payload) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
  // The proxy answering at all means Codex CLI is present: it is the client
  // this product exists for, and there is no separate detection probe.
  if (payload.routingInjected !== true) {
    return {
      ...base,
      state: "absent",
      installed: true,
      applied: false,
      // The command that would fix it beats a restatement of the badge.
      detail: payload.recommendedCommand ?? null,
      detailKey: payload.recommendedCommand ? null : "integrations.detail.codexAbsent",
    };
  }
  return {
    ...base,
    state: payload.status === "error" ? "stale" : "current",
    installed: true,
    applied: true,
    detailKey: "integrations.detail.codexRouted",
  };
}

/** API keys are issued or not; there is no config file to drift. */
function keysRow(count: number | null): OverviewRow {
  const base = {
    id: "keys" as const,
    hash: "integrations/keys",
    labelKey: "integrations.tab.keys" as TKey,
    toggle: null,
    status: null,
    detail: null,
  };
  if (count === null) {
    return { ...base, state: "unknown", installed: false, applied: false, detailKey: null, detailVars: null };
  }
  return {
    ...base,
    state: count > 0 ? "current" : "absent",
    installed: true,
    applied: count > 0,
    detailKey: count > 0 ? "integrations.detail.keyCount" : "integrations.detail.keyNone",
    detailVars: count > 0 ? { count: String(count) } : null,
  };
}

/** `enabled` is the connection switch that used to live in the sidebar. */
function claudeRow(payload: ClaudeCodePayload | null): OverviewRow {
  const base = {
    id: "claude" as const,
    hash: "integrations/claude",
    labelKey: "integrations.tab.claude" as TKey,
    toggle: null,
    status: null,
    detail: null,
    detailVars: null,
  };
  if (!payload) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
  const enabled = payload.enabled === true;
  // The resolved auth mode is the fact a user checks before wondering why a
  // request was refused, so it earns the line over a restated badge.
  const authKey: TKey | null = payload.authMode === "subscription"
    ? "claude.authModeSubscription"
    : payload.authMode === "proxy"
      ? "claude.authModeProxy"
      : payload.authMode === "auto"
        ? "claude.authModeAuto"
        : null;
  return {
    ...base,
    state: enabled ? "current" : "absent",
    installed: true,
    applied: enabled,
    detailKey: enabled ? authKey : "integrations.detail.claudeOff",
  };
}

/**
 * Claude Desktop.
 *
 * `activeProfile === false` is a real applied-but-not-in-effect state: our
 * profile exists in the config library while Desktop serves a different one.
 * It folds into `stale` — the amber badge already means "our block is there
 * but is not what it should be" — rather than claiming a green connection
 * Desktop is not honoring. `null` is undeterminable and must not downgrade a
 * healthy `current`.
 */
function claudeDesktopRow(payload: ClaudeDesktopPayload | null): OverviewRow {
  const base = {
    id: "claudeDesktop" as const,
    hash: "integrations/claude/desktop",
    // "Desktop" alone is ambiguous next to ten other client names.
    labelKey: "claudeDesktop.title" as TKey,
    toggle: null,
    status: null,
    detail: null,
    detailVars: null,
  };
  if (!payload) return { ...base, state: "unknown", installed: false, applied: false, detailKey: null };
  if (payload.applied !== true) {
    return {
      ...base,
      state: "absent",
      installed: true,
      applied: false,
      detailKey: "integrations.detail.desktopAbsent",
    };
  }
  const drifted = payload.stale === true || payload.activeProfile === false;
  return {
    ...base,
    state: drifted ? "stale" : "current",
    installed: true,
    applied: true,
    // Separate sentences: a drifted file and a profile Desktop is not serving
    // are different problems with different fixes.
    detailKey: payload.activeProfile === false
      ? "integrations.detail.desktopNotServed"
      : drifted
        ? "integrations.detail.desktopStale"
        : "integrations.detail.desktopCurrent",
  };
}

/**
 * Grok Build.
 *
 * The route answers `present: false` both when Grok is not installed and when
 * it is installed without our fence, and the payload cannot separate them.
 * Reporting "not installed" for an unfenced install is the safer error: the
 * card still navigates and the Grok tab tells the true story.
 */
function grokRow(payload: GrokPayload | null): OverviewRow {
  const base = {
    id: "grok" as const,
    hash: "integrations/grok",
    labelKey: "integrations.tab.grok" as TKey,
    toggle: null,
    status: null,
    detail: null,
  };
  if (!payload) {
    return { ...base, state: "unknown", installed: false, applied: false, detailKey: null, detailVars: null };
  }
  const present = payload.present === true;
  return {
    ...base,
    state: present ? "current" : "absent",
    installed: present,
    applied: present,
    detailKey: present ? "integrations.detail.grokModels" : "integrations.detail.grokAbsent",
    detailVars: present ? { count: String(payload.models?.length ?? 0) } : null,
  };
}

function fileRow(status: IntegrationStatus): OverviewRow {
  return {
    id: status.clientId,
    hash: `integrations/${status.clientId}`,
    labelKey: FILE_LABEL_KEY[status.clientId],
    // The badge collapses an uninstalled client to "not installed" regardless
    // of its file state; do the same here so the grid and the count agree.
    state: status.installed ? status.state : "not-installed",
    installed: status.installed,
    applied: status.installed && isAppliedState(status.state),
    detail: status.configPath,
    detailKey: null,
    detailVars: null,
    toggle: status.clientId,
    status,
  };
}

/**
 * Catalog order: the two surfaces every user has, then the three native
 * clients, then the file clients in their existing order. It matches the tab
 * strip above the grid, so the eye moves the same way in both.
 */
export function buildOverviewRows(sources: OverviewSources): OverviewRow[] {
  const rows: OverviewRow[] = [
    codexRow(sources.codex),
    keysRow(sources.keyCount),
    claudeRow(sources.claude),
    claudeDesktopRow(sources.claudeDesktop),
    grokRow(sources.grok),
  ];
  for (const clientId of FILE_INTEGRATION_CLIENTS) {
    const status = sources.clients.find(candidate => candidate.clientId === clientId);
    if (status) {
      rows.push(fileRow(status));
      continue;
    }
    // A file client missing from a SETTLED list is a server-side omission and
    // is dropped, as before. Before the list settles every one of them is
    // unknown rather than silently absent.
    if (!sources.clientsSettled) {
      rows.push({
        id: clientId,
        hash: `integrations/${clientId}`,
        labelKey: FILE_LABEL_KEY[clientId],
        state: "unknown",
        installed: false,
        applied: false,
        detail: null,
        detailKey: null,
        detailVars: null,
        toggle: null,
        status: null,
      });
    }
  }
  return rows;
}

export interface OverviewCounts {
  detected: number;
  applied: number;
  stale: number;
  unknown: number;
}

export function countOverviewRows(rows: readonly OverviewRow[]): OverviewCounts {
  return {
    detected: rows.filter(row => row.installed).length,
    applied: rows.filter(row => row.applied).length,
    stale: rows.filter(row => row.state === "stale").length,
    unknown: rows.filter(row => row.state === "unknown").length,
  };
}
