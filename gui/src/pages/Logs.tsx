import { useEffect, useState } from "react";
import { useI18n, LOCALES } from "../i18n";

interface LogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${apiBase}/api/logs`);
        setLogs(await res.json());
      } catch { /* ignore */ }
    };
    fetchLogs();
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [apiBase, autoRefresh]);

  const statusColor = (s: number) => s >= 200 && s < 300 ? "var(--green)" : s >= 400 ? "var(--red)" : "var(--amber)";

  return (
    <>
      <div className="page-head">
        <h2>{t("logs.title")}</h2>
        <label className="muted" style={{ fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          {t("logs.autoRefresh")}
        </label>
      </div>
      <p className="page-sub">{t("logs.subtitle")}</p>

      {logs.length === 0 ? (
        <div className="empty">{t("logs.noRequests")}</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("logs.col.time")}</th>
                <th>{t("logs.col.request")}</th>
                <th>{t("logs.col.model")}</th>
                <th>{t("logs.col.provider")}</th>
                <th>{t("logs.col.status")}</th>
                <th>{t("logs.col.error")}</th>
                <th className="num">{t("logs.col.duration")}</th>
              </tr>
            </thead>
            <tbody>
              {[...logs].reverse().map((log, i) => (
                <tr key={log.requestId ?? `${log.timestamp}-${i}`}>
                  <td className="muted mono">{new Date(log.timestamp).toLocaleTimeString(localeTag)}</td>
                  <td className="muted mono">{log.requestId ?? "-"}</td>
                  <td className="mono">{log.model}</td>
                  <td className="muted">{log.provider}</td>
                  <td>
                    <span className="mono" style={{ color: statusColor(log.status), fontWeight: 600 }}>{log.status}</span>
                  </td>
                  <td className="muted mono">{log.errorCode ?? "-"}</td>
                  <td className="num">{log.durationMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
