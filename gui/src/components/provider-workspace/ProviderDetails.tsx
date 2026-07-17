/**
 * ProviderDetails — the detail header + tab shell (WP090). Owns tab state and
 * composes the Overview/Models/Usage panels; the Settings tab renders disabled
 * until WP091 lands its panel cluster.
 */
import { useState } from "react";
import { useT } from "../../i18n";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { formatProviderDisplayName } from "../../provider-icons";
import { ProviderIcon, statusLabel } from "./ProviderRail";
import ProviderOverview from "./ProviderOverview";
import ProviderModels from "./ProviderModels";
import ProviderUsage from "./ProviderUsage";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import type { ProviderUsageTotals } from "./types";

type Tab = "overview" | "models" | "usage";

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
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: t("pws.tab.overview") },
    { id: "models", label: t("pws.tab.models") },
    { id: "usage", label: t("pws.tab.usage") },
  ];
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
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className="pws-detail-tab"
          disabled
          title={t("pws.settingsComingSoon")}
        >
          {t("pws.tab.settings")}
        </button>
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
    </div>
  );
}
