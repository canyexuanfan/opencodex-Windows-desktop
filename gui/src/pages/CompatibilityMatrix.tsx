import { useCallback, useMemo, useState } from "react";
import { IconRefresh } from "../icons";
import { useI18n, type TKey } from "../i18n/shared";
import { EmptyState, Notice, Select } from "../ui";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import { fetchLabPageData, type LabPageData } from "./compatibility-matrix-api";
import {
  COMPATIBILITY_VERDICTS,
  EVIDENCE_LAYERS,
  buildMatrixRows,
  filterVerdicts,
  formatAsOf,
  shortSubjectId,
  type CompatibilityVerdict,
  type EvidenceLayer,
  type VerdictDto,
  type VerdictFilters,
} from "./compatibility-matrix-shared";

const LAYER_LABEL: Record<EvidenceLayer, TKey> = {
  protocol_conformance: "lab.layer.protocol_conformance",
  live_route_compatibility: "lab.layer.live_route_compatibility",
  task_effectiveness: "lab.layer.task_effectiveness",
};

const LAYER_COLUMN: Record<EvidenceLayer, TKey> = {
  protocol_conformance: "lab.col.protocol",
  live_route_compatibility: "lab.col.live",
  task_effectiveness: "lab.col.task",
};

const VERDICT_LABEL: Record<CompatibilityVerdict, TKey> = {
  UNKNOWN: "lab.verdict.UNKNOWN",
  CLAIMED: "lab.verdict.CLAIMED",
  PROBED: "lab.verdict.PROBED",
  VERIFIED: "lab.verdict.VERIFIED",
  DEGRADED: "lab.verdict.DEGRADED",
  BLOCKED: "lab.verdict.BLOCKED",
  UNSUPPORTED: "lab.verdict.UNSUPPORTED",
};

function localizedFetchError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  const msg = e.message;
  if (
    msg === "Failed to fetch"
    || msg.includes("NetworkError")
    || msg.includes("network error")
  ) {
    return fallback;
  }
  return msg || fallback;
}

function VerdictBadge({
  verdict,
  suiteId,
  label,
}: {
  verdict: CompatibilityVerdict;
  suiteId: string;
  label: string;
}) {
  return (
    <span className="lab-verdict-badge" data-verdict={verdict} title={suiteId}>
      <span>{label}</span>
      <span className="suite">{suiteId}</span>
    </span>
  );
}

function VerdictCell({
  rows,
  t,
}: {
  rows: VerdictDto[];
  t: (key: TKey) => string;
}) {
  if (rows.length === 0) return <span className="muted">–</span>;
  return (
    <div className="lab-verdict-stack">
      {rows.map(row => (
        <VerdictBadge
          key={row.projectionKey}
          verdict={row.verdict}
          suiteId={row.suiteId}
          label={t(VERDICT_LABEL[row.verdict])}
        />
      ))}
    </div>
  );
}

function StatusCards({
  data,
  t,
  locale,
}: {
  data: LabPageData;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  locale: string;
}) {
  const { status } = data;
  const cards: Array<{ label: string; value: string }> = [
    { label: t("lab.subjectCount"), value: String(status.subjectCount ?? 0) },
    { label: t("lab.verdictCount"), value: String(status.verdictCount ?? 0) },
    { label: t("lab.observationCount"), value: String(status.observationCount ?? 0) },
    { label: t("lab.eventCount"), value: String(status.eventCount ?? 0) },
  ];
  if (status.builtAtMs) {
    cards.push({
      label: t("lab.builtAt"),
      value: formatAsOf(status.builtAtMs, locale),
    });
  }
  return (
    <div className="lab-status-grid" aria-label={t("lab.statusTitle")}>
      {cards.map(card => (
        <div className="lab-status-card" key={card.label}>
          <span className="label">{card.label}</span>
          <span className="value">{card.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function CompatibilityMatrix({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<VerdictFilters>({
    layer: "",
    verdict: "",
    subjectQuery: "",
  });

  const resourceKey = `lab-matrix:${apiBase}`;
  const fetchPage = useCallback(
    (signal: AbortSignal) => fetchLabPageData(apiBase, signal),
    [apiBase],
  );

  const surface = useDataSurface(resourceKey, [apiBase], fetchPage, {
    isEmpty: (data: LabPageData) => data.verdicts.length === 0,
    pollMs: 60_000,
  });

  const filteredVerdicts = useMemo(() => {
    if (!surface.data) return [];
    return filterVerdicts(surface.data.verdicts, filters);
  }, [surface.data, filters]);

  const matrixRows = useMemo(() => {
    if (!surface.data) return [];
    return buildMatrixRows(filteredVerdicts, surface.data.subjects);
  }, [filteredVerdicts, surface.data]);

  const layerOptions = [
    { value: "", label: t("lab.filter.all") },
    ...EVIDENCE_LAYERS.map(layer => ({ value: layer, label: t(LAYER_LABEL[layer]) })),
  ];
  const verdictOptions = [
    { value: "", label: t("lab.filter.all") },
    ...COMPATIBILITY_VERDICTS.map(verdict => ({ value: verdict, label: t(VERDICT_LABEL[verdict]) })),
  ];

  if (surface.state.showSkeleton) {
    return (
      <div className="lab-page">
        <div className="page-head"><h2>{t("lab.title")}</h2></div>
        <p className="page-sub">{t("lab.subtitle")}</p>
        <DataSurfaceSkeleton label={t("lab.loading")} rows={5} />
      </div>
    );
  }

  const loadError = surface.state.showError
    ? localizedFetchError(surface.error, t("lab.loadFailed"))
    : null;

  const status = surface.data?.status;
  const projectionUnavailable = status && !status.projectionAvailable;
  const projectionIncompatible = status?.projectionIncompatible === true;

  return (
    <div className="lab-page">
      <div className="lab-toolbar">
        <div>
          <div className="page-head"><h2>{t("lab.title")}</h2></div>
          <p className="page-sub">{t("lab.subtitle")}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => surface.refresh({ forceLoading: true })}
          disabled={surface.refreshing}
        >
          <IconRefresh />
          {t("lab.refresh")}
        </button>
      </div>

      {surface.refreshing && !surface.state.showSkeleton && (
        <DataSurfaceStatus busy live={!loadError}>
          {t("common.loading")}
        </DataSurfaceStatus>
      )}

      {loadError && <Notice tone="err">{loadError}</Notice>}

      {projectionIncompatible && (
        <Notice tone="err">{t("lab.projectionIncompatible")}</Notice>
      )}

      {projectionUnavailable && !projectionIncompatible && (
        <EmptyState title={t("lab.projectionUnavailable")} />
      )}

      {surface.data && status?.projectionAvailable && (
        <>
          <StatusCards data={surface.data} t={t} locale={locale} />

          <div className="lab-filters">
            <div className="lab-filter-field">
              <label htmlFor="lab-filter-layer">{t("lab.filter.layer")}</label>
              <Select
                id="lab-filter-layer"
                value={filters.layer}
                options={layerOptions}
                onChange={value => setFilters(current => ({
                  ...current,
                  layer: value as EvidenceLayer | "",
                }))}
                label={t("lab.filter.layer")}
                portal={false}
              />
            </div>
            <div className="lab-filter-field">
              <label htmlFor="lab-filter-verdict">{t("lab.filter.verdict")}</label>
              <Select
                id="lab-filter-verdict"
                value={filters.verdict}
                options={verdictOptions}
                onChange={value => setFilters(current => ({
                  ...current,
                  verdict: value as CompatibilityVerdict | "",
                }))}
                label={t("lab.filter.verdict")}
                portal={false}
              />
            </div>
            <div className="lab-filter-field">
              <label htmlFor="lab-filter-subject">{t("lab.filter.subject")}</label>
              <input
                id="lab-filter-subject"
                type="search"
                value={filters.subjectQuery}
                onChange={event => setFilters(current => ({
                  ...current,
                  subjectQuery: event.target.value,
                }))}
                placeholder={t("lab.filter.subject")}
              />
            </div>
          </div>

          {matrixRows.length === 0 ? (
            <EmptyState title={t("lab.empty")} />
          ) : (
            <>
              <div className="lab-matrix-block">
                <h3 className="lab-matrix-title">{t("lab.matrixTitle")}</h3>
                <div className="lab-matrix-scroll">
                  <table className="lab-matrix">
                    <thead>
                      <tr>
                        <th>{t("lab.col.subject")}</th>
                        <th>{t("lab.subjectKind")}</th>
                        {EVIDENCE_LAYERS.map(layer => (
                          <th key={layer}>{t(LAYER_COLUMN[layer])}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matrixRows.map(row => (
                        <tr key={row.subjectId}>
                          <td className="subject" title={row.subjectId}>
                            {shortSubjectId(row.subjectId)}
                          </td>
                          <td className="kind">{row.subjectKind}</td>
                          {EVIDENCE_LAYERS.map(layer => (
                            <td key={layer}>
                              <VerdictCell rows={row.byLayer[layer]} t={t} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="lab-matrix-block">
                <h3 className="lab-matrix-title">{t("lab.verdictsTitle")}</h3>
                <div className="lab-matrix-scroll">
                  <table className="lab-detail-table">
                    <thead>
                      <tr>
                        <th>{t("lab.col.subject")}</th>
                        <th>{t("lab.col.layer")}</th>
                        <th>{t("lab.col.suite")}</th>
                        <th>{t("lab.col.verdict")}</th>
                        <th>{t("lab.col.asOf")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVerdicts.map(verdict => (
                        <tr key={verdict.projectionKey}>
                          <td className="mono" title={verdict.subjectId}>
                            {shortSubjectId(verdict.subjectId)}
                          </td>
                          <td>{t(LAYER_LABEL[verdict.evidenceLayer])}</td>
                          <td className="mono">{verdict.suiteId}</td>
                          <td>
                            <VerdictBadge
                              verdict={verdict.verdict}
                              suiteId={verdict.suiteVersion}
                              label={t(VERDICT_LABEL[verdict.verdict])}
                            />
                          </td>
                          <td>{formatAsOf(verdict.asOf, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
