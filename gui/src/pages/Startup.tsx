import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconCheck, IconPower, IconRefresh, IconTerminal } from "../icons";
import { useI18n, type TKey } from "../i18n/shared";
import { EmptyState } from "../ui";

type StartupStatus = "native" | "protected" | "at-risk";
type StartupProtection = "service" | "shim" | "none";

interface StartupHealthData {
  status: StartupStatus;
  routingInjected: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  serviceInstalled: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: "full" | "cli-only" | "none";
  platform: string;
  recommendedCommand: string | null;
  commands: {
    installService: string;
    installShim: string;
    restoreNative: string;
  };
}

const STATUS_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.status.native",
  protected: "startup.status.protected",
  "at-risk": "startup.status.atRisk",
};

const SUMMARY_KEYS: Record<StartupStatus, TKey> = {
  native: "startup.summary.native",
  protected: "startup.summary.protected",
  "at-risk": "startup.summary.atRisk",
};

const PROTECTION_KEYS: Record<StartupProtection, TKey> = {
  service: "startup.protection.service",
  shim: "startup.protection.shim",
  none: "startup.protection.none",
};

function StateBadge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={`badge ${ok ? "badge-green" : "badge-amber"}`}>{ok ? yes : no}</span>;
}

export default function Startup({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<StartupHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/startup-health`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const next = await res.json() as StartupHealthData;
      if (signal?.aborted) return;
      setData(next);
      setFailed(false);
    } catch {
      if (signal?.aborted) return;
      setFailed(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refresh]);

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      window.setTimeout(() => setCopied(current => current === command ? null : current), 1600);
    } catch {
      setCopied(null);
    }
  };

  const statusClass = data?.status === "protected"
    ? "startup-hero--safe"
    : data?.status === "at-risk"
      ? "startup-hero--risk"
      : "startup-hero--native";
  const StatusIcon = data?.status === "at-risk" ? IconAlert : IconCheck;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{t("startup.title")}</h2>
          <p className="page-sub startup-page-sub">{t("startup.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>
          <IconRefresh /> {t("startup.refresh")}
        </button>
      </div>

      {loading && !data ? (
        <EmptyState title={t("startup.loading")} />
      ) : failed && !data ? (
        <EmptyState title={t("startup.error")} />
      ) : data ? (
        <>
          <section className={`panel startup-hero ${statusClass}`} aria-live="polite">
            <div className="startup-hero-icon"><StatusIcon /></div>
            <div className="startup-hero-copy">
              <span className={`badge ${data.status === "at-risk" ? "badge-amber" : "badge-green"}`}>
                {t(STATUS_KEYS[data.status])}
              </span>
              <h3>{t(SUMMARY_KEYS[data.status])}</h3>
              <p>{data.status === "at-risk"
                ? t(data.shimCoverage === "cli-only" ? "startup.riskDetailWindowsShim" : "startup.riskDetail")
                : t("startup.safeDetail")}</p>
            </div>
          </section>

          <div className="startup-state-grid">
            <section className="stat">
              <div className="label">{t("startup.routing")}</div>
              <div className="value">{t(data.routingInjected ? "startup.routing.proxy" : "startup.routing.native")}</div>
            </section>
            <section className="stat">
              <div className="label">{t("startup.restartProtection")}</div>
              <div className="value">{t(PROTECTION_KEYS[data.protection])}</div>
            </section>
            <section className="stat">
              <div className="label">{t("startup.preference")}</div>
              <div className="value">{t(data.autostartEnabled ? "startup.enabled" : "startup.disabled")}</div>
            </section>
          </div>

          <section className="panel startup-details">
            <div className="panel-head">
              <h3 className="panel-title">{t("startup.details")}</h3>
              <span className="muted mono">{data.platform}</span>
            </div>
            <div className="startup-detail-row">
              <div><strong>{t("startup.service")}</strong><span>{t("startup.serviceHint")}</span></div>
              <StateBadge ok={data.serviceInstalled} yes={t("startup.installed")} no={t(data.serviceSupported ? "startup.notInstalled" : "startup.unsupported")} />
            </div>
            <div className="startup-detail-row">
              <div><strong>{t("startup.shim")}</strong><span>{t("startup.shimHint")}</span></div>
              <StateBadge
                ok={data.shimHealthy}
                yes={t(data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy")}
                no={t(data.shimInstalled ? "startup.stale" : "startup.notInstalled")}
              />
            </div>
          </section>

          <section className="panel startup-actions">
            <div className="panel-head">
              <h3 className="panel-title">{t("startup.recovery")}</h3>
              <IconTerminal />
            </div>
            <p className="muted">{t("startup.recoveryHint")}</p>
            <div className="startup-command-list">
              <div className="startup-command-row">
                <div>
                  <strong>{t("startup.command.service")}</strong>
                  <code>{data.commands.installService}</code>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(data.commands.installService)}>
                  {copied === data.commands.installService ? t("startup.copied") : t("startup.copy")}
                </button>
              </div>
              <div className="startup-command-row">
                <div>
                  <strong>{t("startup.command.shim")}</strong>
                  <code>{data.commands.installShim}</code>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(data.commands.installShim)}>
                  {copied === data.commands.installShim ? t("startup.copied") : t("startup.copy")}
                </button>
              </div>
              <div className="startup-command-row">
                <div>
                  <strong>{t("startup.command.native")}</strong>
                  <code>{data.commands.restoreNative}</code>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(data.commands.restoreNative)}>
                  {copied === data.commands.restoreNative ? t("startup.copied") : t("startup.copy")}
                </button>
              </div>
            </div>
            {data.status === "at-risk" && (
              <div className="notice notice-warn startup-action-notice" role="alert">
                <IconPower /> {t("startup.recommended", { cmd: data.recommendedCommand ?? data.commands.installService })}
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
