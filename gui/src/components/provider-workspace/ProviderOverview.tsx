/**
 * ProviderOverview — connection card, stats sidebar, and a static auth summary
 * line (WP090). The full auth/accounts card arrives with WP091; until then the
 * summary renders known status only — no links.
 */
import { useT } from "../../i18n";
import { useI18n } from "../../i18n";
import { IconAlert, IconCheck } from "../../icons";
import { binProviderStatus, type WorkspaceItem } from "../../provider-workspace/catalog";
import { formatRelativeTime, relativeTimeLabelsFromT, formatRequestCount, formatTokenCount } from "../../provider-workspace/usage";
import { accountQuotaFromReport, formatQuotaSourceLabel, type ProviderQuotaReportView } from "../../provider-workspace/report";
import type { ProviderUsageTotals } from "./types";
import { authModeLabel } from "./ProviderRail";

export default function ProviderOverview({ item, usageTotals, quotaReport, oauthEmail }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  /** Logged-in email when known (classic page oauth status); renders as static text. */
  oauthEmail?: string;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);
  const status = binProviderStatus(item);
  const statusText = status === "ready"
    ? t("pws.status.connected")
    : status === "needs-setup" ? t("pws.status.needsSetup") : t("prov.disabledBadge");
  const requests = usageTotals?.requests;
  const tokens = usageTotals?.totalTokens;
  const quota = accountQuotaFromReport(quotaReport);
  return (
    <div className="pws-overview">
      <section className="pws-section" aria-label={t("pws.connection")}>
        <h3 className="pws-section-title">{t("pws.connection")}</h3>
        <dl className="pws-kv">
          <div className="pws-kv-row">
            <dt>{t("dash.status")}</dt>
            <dd className={status === "ready" ? "pws-status-ok" : "pws-status-warn"}>
              {status === "ready"
                ? <IconCheck style={{ width: 13, height: 13 }} aria-hidden="true" />
                : <IconAlert style={{ width: 13, height: 13 }} aria-hidden="true" />}
              {statusText}
            </dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("modal.baseUrl")}</dt>
            <dd><code>{item.baseUrl?.trim() ? item.baseUrl : "—"}</code></dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("pws.cell.auth")}</dt>
            <dd>{oauthEmail ? `${authModeLabel(item, t)} · ${oauthEmail}` : authModeLabel(item, t)}</dd>
          </div>
          <div className="pws-kv-row">
            <dt>{t("modal.defaultModel")}</dt>
            <dd>{item.defaultModel ?? <span className="muted">—</span>}</dd>
          </div>
          {item.note && (
            <div className="pws-kv-row">
              <dt>{t("pws.cell.note")}</dt>
              <dd className="muted">{item.note}</dd>
            </div>
          )}
        </dl>
      </section>
      <aside className="pws-section pws-section--side" aria-label={t("pws.statsAria")}>
        <h3 className="pws-section-title">{t("pws.statsTitle")}</h3>
        <dl className="pws-kv">
          {typeof requests === "number" && (
            <div className="pws-kv-row">
              <dt>{t("pws.stats.totalRequests")}</dt>
              <dd className="pws-kv-mono">{formatRequestCount(requests, locale)}</dd>
            </div>
          )}
          {typeof tokens === "number" && (
            <div className="pws-kv-row">
              <dt>{t("pws.stats.totalTokens")}</dt>
              <dd className="pws-kv-mono">{formatTokenCount(tokens, locale)}</dd>
            </div>
          )}
          {quotaReport && (
            <div className="pws-kv-row">
              <dt>{t("pws.stats.quotaUpdated")}</dt>
              <dd
                className="pws-kv-mono"
                title={quotaReport.source ? formatQuotaSourceLabel(quotaReport.source) : undefined}
              >
                {formatRelativeTime(quotaReport.updatedAt, timeLabels)}
              </dd>
            </div>
          )}
          {typeof requests !== "number" && typeof tokens !== "number" && !quotaReport && (
            <div className="muted">{t("pws.usageUnavailable")}</div>
          )}
        </dl>
        {quota && <div className="muted pws-stats-note">{t("pws.stats.quotaTracked")}</div>}
      </aside>
    </div>
  );
}
