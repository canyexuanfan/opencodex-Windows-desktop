/**
 * ProviderDetails — the detail header + tab shell (WP090+091). Owns tab state
 * and composes the Overview/Models/Usage/Settings panels.
 */
import { useCallback, useState } from "react";
import { useT } from "../../i18n";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { formatProviderDisplayName } from "../../provider-icons";
import { ProviderIcon, statusLabel } from "./ProviderRail";
import ProviderOverview from "./ProviderOverview";
import ProviderModels from "./ProviderModels";
import ProviderUsage from "./ProviderUsage";
import ProviderAuthPanel from "./ProviderAuthPanel";
import ProviderSettings from "./ProviderSettings";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import type { ProviderUsageTotals, OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers, ProviderUpdatePatch } from "./types";

type Tab = "overview" | "models" | "usage" | "settings";

export default function ProviderDetails({
  item,
  usageTotals,
  quotaReport,
  availableModels,
  selectedModels,
  modelsLoading,
  modelsLoadFailed,
  onRetryModels,
  oauthEmail,
  onDeselect,
  apiBase,
  oauth,
  accounts,
  keys,
  busyProvider,
  loginHint,
  authHandlers,
  onUpdateProvider,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  onRetryModels?: () => void;
  oauthEmail?: string;
  onDeselect: () => void;
  apiBase: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  busyProvider?: string | null;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("overview");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: t("pws.tab.overview") },
    { id: "models", label: t("pws.tab.models") },
    { id: "usage", label: t("pws.tab.usage") },
    { id: "settings", label: t("pws.tab.settings") },
  ];

  const switchTab = useCallback((next: Tab) => {
    if (settingsDirty && tab === "settings" && next !== "settings") {
      if (!window.confirm(t("pws.unsavedLeaveBody"))) return;
    }
    setTab(next);
  }, [tab, settingsDirty, t]);

  return (
    <div className="pws-detail">
      <div className="pws-detail-head">
        <ProviderIcon name={item.name} adapter={item.adapter} baseUrl={item.baseUrl} cls="pws-detail-icon" />
        <div className="pws-detail-title-wrap">
          <h2 className="pws-detail-title">{formatProviderDisplayName(item.name)}</h2>
          <span className="muted">{statusLabel(item, t)}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDeselect}>
          {t("modal.back")}
        </button>
      </div>
      <div className="pws-detail-tabs" role="tablist">
        {tabs.map(candidate => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={tab === candidate.id}
            className={`pws-detail-tab${tab === candidate.id ? " pws-detail-tab--active" : ""}`}
            onClick={() => switchTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <ProviderOverview item={item} usageTotals={usageTotals} quotaReport={quotaReport} oauthEmail={oauthEmail} />
      )}
      {tab === "models" && (
        <ProviderModels
          item={item}
          availableModels={availableModels}
          selectedModels={selectedModels}
          modelsLoading={modelsLoading}
          modelsLoadFailed={modelsLoadFailed}
          onRetryModels={onRetryModels}
        />
      )}
      {tab === "usage" && (
        <ProviderUsage item={item} usageTotals={usageTotals} quotaReport={quotaReport} />
      )}
      {tab === "settings" && (
        <>
          <ProviderSettings
            item={item}
            availableModels={availableModels}
            onUpdateProvider={onUpdateProvider}
            onDirtyChange={setSettingsDirty}
          />
          <ProviderAuthPanel
            item={item}
            apiBase={apiBase}
            oauth={oauth}
            accounts={accounts}
            keys={keys}
            busy={busyProvider === item.name}
            loginHint={loginHint}
            authHandlers={authHandlers}
          />
        </>
      )}
    </div>
  );
}
