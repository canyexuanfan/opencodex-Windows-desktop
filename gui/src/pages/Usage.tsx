import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";

type Range = "all" | "30d" | "7d";

interface UsageSummaryTotals {
  requests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
}

interface UsageDay {
  date: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
}

interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

interface UsageProvider {
  provider: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

interface UsageResponse {
  range: Range;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  error?: string;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

function buildHeatmap(days: UsageDay[]): { weeks: HeatmapCell[][]; buckets: number[] } {
  const buckets = quantileBuckets(days.map(d => d.requests));
  const cells: HeatmapCell[] = days.map(d => {
    const dt = new Date(`${d.date}T00:00:00`);
    return {
      date: d.date,
      requests: d.requests,
      totalTokens: d.totalTokens,
      level: bucketLevel(d.requests, buckets),
      dayOfWeek: dt.getDay(),
    };
  });
  if (cells.length === 0) return { weeks: [], buckets };
  const weeks: HeatmapCell[][] = [];
  let week: HeatmapCell[] = new Array(cells[0].dayOfWeek).fill(null).map(() => ({
    date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: 0,
  }));
  for (const cell of cells) {
    week.push(cell);
    if (cell.dayOfWeek === 6) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, buckets };
}

export default function Usage({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelQuery, setModelQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const fetchUsage = async () => {
      try {
        const res = await fetch(`${apiBase}/api/usage?range=${range}`);
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json() as UsageResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUsage();
    return () => { cancelled = true; };
  }, [apiBase, range]);

  const heatmap = useMemo(() => buildHeatmap(data?.days ?? []), [data?.days]);
  const activeDays = useMemo(() => (data?.days ?? []).filter(d => d.requests > 0).length, [data?.days]);
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const models = data?.models ?? [];
    if (!q) return models.slice(0, 100);
    return models.filter(m =>
      m.model.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.resolvedModel ?? "").toLowerCase().includes(q),
    ).slice(0, 100);
  }, [data?.models, modelQuery]);

  return (
    <>
      <div className="page-head">
        <h2>{t("usage.title")}</h2>
        <div className="usage-range" role="group" aria-label={t("usage.title")}>
          {(["all", "30d", "7d"] as Range[]).map(r => (
            <button key={r} type="button"
              className={`usage-range-btn${range === r ? " active" : ""}`}
              onClick={() => setRange(r)}>
              {t(`usage.range.${r}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="page-sub">{t("usage.subtitle")}</p>

      {loading && !data ? (
        <div className="empty">{t("usage.loading")}</div>
      ) : !data || data.summary.requests === 0 ? (
        <div className="empty">{t("usage.empty")}</div>
      ) : (
        <>
          <div className="usage-cards">
            <div className="stat"><div className="muted">{t("usage.card.requests")}</div><div className="stat-value">{data.summary.requests}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.reported")}</div><div className="stat-value">{data.summary.reportedRequests}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.totalTokens")}</div><div className="stat-value">{formatTokens(data.summary.totalTokens)}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.coverage")}</div><div className="stat-value">{formatPct(data.summary.coverageRatio)}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.activeDays")}</div><div className="stat-value">{activeDays}</div></div>
          </div>

          <section className="panel" style={{ marginTop: 16 }}>
            <h3 className="panel-title">{t("usage.section.heatmap")}</h3>
            <div className="heatmap">
              <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 12px)` }}>
                {heatmap.weeks.map((week, wi) => (
                  <div key={wi} className="heatmap-week">
                    {week.map((cell, di) => (
                      <div key={`${wi}-${di}`}
                        className={`heatmap-cell heatmap-cell-${cell.level}`}
                        title={cell.date ? `${cell.date}: ${cell.requests} req · ${formatTokens(cell.totalTokens)} tokens` : ""} />
                    ))}
                  </div>
                ))}
              </div>
              <div className="heatmap-legend muted">
                <span>{t("usage.heatmap.less")}</span>
                {[0, 1, 2, 3, 4].map(l => <span key={l} className={`heatmap-cell heatmap-cell-${l}`} />)}
                <span>{t("usage.heatmap.more")}</span>
              </div>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head">
              <h3 className="panel-title">{t("usage.section.models")}</h3>
              <input className="input" placeholder={t("usage.search.models")}
                value={modelQuery} onChange={e => setModelQuery(e.target.value)} />
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("logs.col.model")}</th>
                    <th>{t("logs.col.provider")}</th>
                    <th className="num">{t("usage.col.requests")}</th>
                    <th className="num">{t("usage.col.reported")}</th>
                    <th className="num">{t("usage.col.tokens")}</th>
                    <th>{t("usage.col.share")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map(m => (
                    <tr key={`${m.provider}/${m.model}/${m.resolvedModel ?? ""}`}>
                      <td className="mono">{m.resolvedModel ?? m.model}</td>
                      <td className="muted">{m.provider}</td>
                      <td className="num">{m.requests}</td>
                      <td className="num">{m.reportedRequests}</td>
                      <td className="num mono">{formatTokens(m.totalTokens)}</td>
                      <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(m.shareRatio * 100)}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h3 className="panel-title">{t("usage.section.providers")}</h3>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("logs.col.provider")}</th>
                    <th className="num">{t("usage.col.requests")}</th>
                    <th className="num">{t("usage.col.reported")}</th>
                    <th className="num">{t("usage.col.tokens")}</th>
                    <th>{t("usage.col.share")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map(p => (
                    <tr key={p.provider}>
                      <td className="mono">{p.provider}</td>
                      <td className="num">{p.requests}</td>
                      <td className="num">{p.reportedRequests}</td>
                      <td className="num mono">{formatTokens(p.totalTokens)}</td>
                      <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(p.shareRatio * 100)}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h3 className="panel-title">{t("usage.section.coverage")}</h3>
            <div className="usage-cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              <div className="stat"><div className="muted">{t("logs.tokens.reported")}</div><div className="stat-value">{data.summary.reportedRequests}</div></div>
              <div className="stat"><div className="muted">{t("logs.tokens.unreported")}</div><div className="stat-value">{data.summary.unreportedRequests}</div></div>
              <div className="stat"><div className="muted">{t("logs.tokens.unsupported")}</div><div className="stat-value">{data.summary.unsupportedRequests}</div></div>
            </div>
            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>{t("usage.coverage.note")}</p>
          </section>
        </>
      )}
    </>
  );
}
