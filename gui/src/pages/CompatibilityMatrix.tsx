import { useCallback, useEffect, useMemo, useState } from "react";
import { IconRefresh } from "../icons";
import { useI18n, type TKey } from "../i18n/shared";
import { EmptyState, Notice, Select } from "../ui";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import {
  fetchLabPageData,
  fetchMoreVerdicts,
  fetchVerdictDetail,
  type LabPageData,
  type VerdictDetailData,
} from "./compatibility-matrix-api";
import {
  COMPATIBILITY_VERDICTS,
  EVIDENCE_LAYERS,
  buildMatrixRows,
  formatAsOf,
  shortSubjectId,
  verdictQueryFromFilters,
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
  selected,
  onSelect,
}: {
  verdict: CompatibilityVerdict;
  suiteId: string;
  label: string;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const className = `lab-verdict-badge${selected ? " lab-verdict-badge--selected" : ""}`;
  if (onSelect) {
    return (
      <button type="button" className={className} data-verdict={verdict} title={suiteId} onClick={onSelect}>
        <span>{label}</span>
        <span className="suite">{suiteId}</span>
      </button>
    );
  }
  return (
    <span className={className} data-verdict={verdict} title={suiteId}>
      <span>{label}</span>
      <span className="suite">{suiteId}</span>
    </span>
  );
}

function VerdictCell({
  rows,
  t,
  selectedKey,
  onSelect,
}: {
  rows: VerdictDto[];
  t: (key: TKey) => string;
  selectedKey: string | null;
  onSelect: (verdict: VerdictDto) => void;
}) {
  if (rows.length === 0) return <span className="muted">-</span>;
  return (
    <div className="lab-verdict-stack">
      {rows.map(row => (
        <VerdictBadge
          key={row.projectionKey}
          verdict={row.verdict}
          suiteId={row.suiteId}
          label={t(VERDICT_LABEL[row.verdict])}
          selected={selectedKey === row.projectionKey}
          onSelect={() => onSelect(row)}
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

function DetailPane({
  verdict,
  detail,
  loading,
  error,
  t,
  locale,
  onClose,
}: {
  verdict: VerdictDto;
  detail: VerdictDetailData | null;
  loading: boolean;
  error: string | null;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  locale: string;
  onClose: () => void;
}) {
  return (
    <aside className="lab-detail-pane" aria-label={t("lab.detailTitle")}>
      <div className="lab-detail-head">
        <h3>{shortSubjectId(verdict.subjectId)}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          {t("lab.detailClose")}
        </button>
      </div>
      <dl className="lab-detail-meta">
        <div><dt>{t("lab.col.layer")}</dt><dd>{t(LAYER_LABEL[verdict.evidenceLayer])}</dd></div>
        <div><dt>{t("lab.col.suite")}</dt><dd className="mono">{verdict.suiteId}</dd></div>
        <div><dt>{t("lab.col.verdict")}</dt><dd>{t(VERDICT_LABEL[verdict.verdict])}</dd></div>
        <div><dt>{t("lab.col.asOf")}</dt><dd>{formatAsOf(verdict.asOf, locale)}</dd></div>
      </dl>
      {loading && <DataSurfaceStatus busy>{t("common.loading")}</DataSurfaceStatus>}
      {error && <Notice tone="err">{error}</Notice>}
      {detail && (
        <>
          {detail.subject && (
            <section className="lab-detail-section">
              <h4>{t("lab.detailSubject")}</h4>
              <p className="mono">{detail.subject.subjectKind}</p>
            </section>
          )}
          {detail.observations.length > 0 && (
            <section className="lab-detail-section">
              <h4>{t("lab.detailObservations")}</h4>
              <ul className="lab-detail-list">
                {detail.observations.map(obs => (
                  <li key={obs.eventId}>
                    <span className="mono">{obs.scenarioId}</span>
                    <span>{obs.outcome}</span>
                    <span className="muted">{formatAsOf(obs.completedAt, locale)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail.events.length > 0 && (
            <section className="lab-detail-section">
              <h4>{t("lab.detailEvents")}</h4>
              <ul className="lab-detail-list">
                {detail.events.map(event => (
                  <li key={event.eventId}>
                    <span className="mono">{event.eventId}</span>
                    <span>{event.eventKind}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail.artifacts.length > 0 && (
            <section className="lab-detail-section">
              <h4>{t("lab.detailArtifacts")}</h4>
              <ul className="lab-detail-list">
                {detail.artifacts.map(artifact => (
                  <li key={artifact.digest}>
                    <span className="mono" title={artifact.digest}>{shortSubjectId(artifact.digest)}</span>
                    <span>{artifact.artifactClass ?? "-"}</span>
                    <span>{artifact.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </aside>
  );
}

export default function CompatibilityMatrix({
  apiBase,
  active = true,
  onCountChange,
}: {
  apiBase: string;
  active?: boolean;
  onCountChange?: (count: number | null) => void;
}) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<VerdictFilters>({
    layer: "",
    verdict: "",
    subjectQuery: "",
    suiteId: "",
  });
  const [extraVerdicts, setExtraVerdicts] = useState<VerdictDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedVerdict, setSelectedVerdict] = useState<VerdictDto | null>(null);
  const [detail, setDetail] = useState<VerdictDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const queryFilters = useMemo(() => verdictQueryFromFilters(filters), [filters]);
  const queryKey = JSON.stringify(queryFilters);

  const fetchPage = useCallback(
    (signal: AbortSignal) => fetchLabPageData(apiBase, queryFilters, signal),
    [apiBase, queryFilters],
  );

  const resourceKey = `lab-matrix:${apiBase}:${queryKey}`;
  const surface = useDataSurface(resourceKey, [apiBase, queryKey], fetchPage, {
    isEmpty: (data: LabPageData) => data.verdicts.length === 0,
    pollMs: 60_000,
    enabled: active,
    pauseWhenHidden: !active,
  });

  const updateFilters = useCallback((updater: (current: VerdictFilters) => VerdictFilters) => {
    setFilters(updater);
    setExtraVerdicts([]);
    setNextCursor(undefined);
    setHasMore(false);
  }, []);

  const reportedCount = useMemo(() => {
    if (!active) return null;
    if (!surface.data?.status.projectionAvailable) return null;
    const total = surface.data.status.verdictCount;
    return typeof total === "number" ? total : surface.data.verdicts.length + extraVerdicts.length;
  }, [active, extraVerdicts.length, surface.data]);

  useEffect(() => {
    onCountChange?.(reportedCount);
  }, [onCountChange, reportedCount]);

  const allVerdicts = useMemo(() => {
    if (!surface.data) return [];
    return [...surface.data.verdicts, ...extraVerdicts];
  }, [extraVerdicts, surface.data]);

  const matrixRows = useMemo(() => {
    if (!surface.data) return [];
    return buildMatrixRows(allVerdicts, surface.data.subjects);
  }, [allVerdicts, surface.data]);

  const loadMore = async () => {
    const cursor = nextCursor ?? surface.data?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const controller = new AbortController();
      const page = await fetchMoreVerdicts(apiBase, queryFilters, cursor, controller.signal);
      setExtraVerdicts(current => [...current, ...page.verdicts]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      // keep current page; user can refresh
    } finally {
      setLoadingMore(false);
    }
  };

  const visibleSelection = active ? selectedVerdict : null;

  const selectVerdict = useCallback(async (verdict: VerdictDto) => {
    if (!active) return;
    setSelectedVerdict(verdict);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setFilters(current => ({ ...current, suiteId: verdict.suiteId }));
    try {
      const controller = new AbortController();
      const loaded = await fetchVerdictDetail(apiBase, verdict, controller.signal);
      setDetail(loaded);
    } catch (e) {
      setDetailError(localizedFetchError(e, t("lab.detailLoadFailed")));
    } finally {
      setDetailLoading(false);
    }
  }, [active, apiBase, t]);

  const pageHasMore = extraVerdicts.length > 0 ? hasMore : (surface.data?.hasMore ?? false);

  const layerOptions = [
    { value: "", label: t("lab.filter.all") },
    ...EVIDENCE_LAYERS.map(layer => ({ value: layer, label: t(LAYER_LABEL[layer]) })),
  ];
  const verdictOptions = [
    { value: "", label: t("lab.filter.all") },
    ...COMPATIBILITY_VERDICTS.map(verdict => ({ value: verdict, label: t(VERDICT_LABEL[verdict]) })),
  ];

  if (surface.state.showSkeleton) {
    return <DataSurfaceSkeleton label={t("lab.loading")} rows={5} />;
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

      {surface.data && status?.projectionAvailable && !projectionIncompatible && (
        <div className="lab-layout">
          <div className="lab-main">
            <StatusCards data={surface.data} t={t} locale={locale} />

            <div className="lab-filters">
              <div className="lab-filter-field">
                <label htmlFor="lab-filter-layer">{t("lab.filter.layer")}</label>
                <Select
                  id="lab-filter-layer"
                  value={filters.layer}
                  options={layerOptions}
                onChange={value => updateFilters(current => ({
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
                onChange={value => updateFilters(current => ({
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
                onChange={event => updateFilters(current => ({
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
                                <VerdictCell
                                  rows={row.byLayer[layer]}
                                  t={t}
                                  selectedKey={visibleSelection?.projectionKey ?? null}
                                  onSelect={selectVerdict}
                                />
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
                        {allVerdicts.map(verdict => (
                          <tr
                            key={verdict.projectionKey}
                            className={visibleSelection?.projectionKey === verdict.projectionKey ? "selected" : ""}
                            tabIndex={0}
                            onClick={() => { void selectVerdict(verdict); }}
                            onKeyDown={event => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                void selectVerdict(verdict);
                              }
                            }}
                          >
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

                {pageHasMore && (
                  <div className="lab-load-more">
                    <button type="button" className="btn btn-ghost" disabled={loadingMore} onClick={() => { void loadMore(); }}>
                      {loadingMore ? t("common.loading") : t("lab.loadMore")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {visibleSelection && (
            <DetailPane
              verdict={visibleSelection}
              detail={detail}
              loading={detailLoading}
              error={detailError}
              t={t}
              locale={locale}
              onClose={() => {
                setSelectedVerdict(null);
                setDetail(null);
                setDetailError(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
