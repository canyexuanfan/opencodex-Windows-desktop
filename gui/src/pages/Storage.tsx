import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type TFn, type TKey, type Locale } from "../i18n/shared";
import { EmptyState } from "../ui";
import { IconRefresh } from "../icons";
import { formatBytes } from "../format-bytes";

interface StorageLargestEntry {
  path: string;
  bytes: number;
}

interface StorageBucket {
  key: string;
  label: string;
  bytes: number;
  fileCount: number;
  oldest?: number;
  newest?: number;
  largest?: StorageLargestEntry[];
  rows?: number | null;
}

interface StorageReport {
  codexHome: string;
  generatedAt: number;
  total: { bytes: number; fileCount: number };
  buckets: StorageBucket[];
  error?: string;
}

interface CleanupPreview {
  percent: number;
  count: number;
  bytes: number;
  candidates: Array<{ relPath: string; bytes: number }>;
}

interface CleanupResult {
  ok: boolean;
  mode: "quarantine" | "permanent";
  count: number;
  bytes: number;
  trashDir?: string;
  error?: string;
  message?: string;
}

const BUCKET_TKEYS: Record<string, TKey> = {
  sessions: "storage.bucket.sessions",
  archived_sessions: "storage.bucket.archived_sessions",
  logs_db: "storage.bucket.logs_db",
  state_db: "storage.bucket.state_db",
  attachments: "storage.bucket.attachments",
  deletion_manifests: "storage.bucket.deletion_manifests",
  other: "storage.bucket.other",
};

const PRESETS = [10, 25, 50] as const;

function bucketLabel(bucket: StorageBucket, t: TFn): string {
  const tkey = BUCKET_TKEYS[bucket.key];
  return tkey ? t(tkey) : bucket.label;
}

function formatDate(ms: number | undefined, locale: Locale): string {
  return ms === undefined ? "—" : new Date(ms).toLocaleDateString(locale);
}

function BucketsTable({ buckets, locale, t }: { buckets: StorageBucket[]; locale: Locale; t: TFn }) {
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-buckets-title">
      <h3 id="storage-buckets-title" className="panel-title">{t("storage.section.buckets")}</h3>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t("storage.col.bucket")}</th>
              <th className="num">{t("storage.col.size")}</th>
              <th className="num">{t("storage.col.files")}</th>
              <th>{t("storage.col.oldest")}</th>
              <th>{t("storage.col.newest")}</th>
              <th className="num">{t("storage.col.rows")}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map(bucket => (
              <tr key={bucket.key}>
                <td>{bucketLabel(bucket, t)}</td>
                <td className="num mono">{formatBytes(bucket.bytes, locale)}</td>
                <td className="num">{bucket.fileCount}</td>
                <td className="muted">{formatDate(bucket.oldest, locale)}</td>
                <td className="muted">{formatDate(bucket.newest, locale)}</td>
                <td className="num mono">
                  {bucket.rows === undefined ? "—" : bucket.rows === null ? t("storage.rows.unknown") : bucket.rows.toLocaleString(locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LargestFilesPanel({ buckets, locale, t }: { buckets: StorageBucket[]; locale: Locale; t: TFn }) {
  const withLargest = buckets.filter(bucket => (bucket.largest?.length ?? 0) > 0);
  if (withLargest.length === 0) return null;
  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-largest-title">
      <h3 id="storage-largest-title" className="panel-title">{t("storage.section.largest")}</h3>
      {withLargest.map(bucket => (
        <details key={bucket.key} style={{ marginTop: 8 }}>
          <summary>{bucketLabel(bucket, t)}</summary>
          <div className="tbl-wrap" style={{ marginTop: 8 }}>
            <table className="tbl">
              <tbody>
                {bucket.largest!.map(entry => (
                  <tr key={entry.path}>
                    <td className="mono">{entry.path}</td>
                    <td className="num mono">{formatBytes(entry.bytes, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </section>
  );
}

function ArchivedCleanupPanel({
  apiBase,
  locale,
  t,
  onDone,
}: {
  apiBase: string;
  locale: Locale;
  t: TFn;
  onDone: () => void;
}) {
  const [percent, setPercent] = useState(25);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!confirmOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [confirmOpen, busy]);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent }),
      });
      const json = await res.json() as CleanupPreview & { error?: string };
      if (!res.ok) throw new Error(json.error ?? t("storage.cleanup.previewFailed"));
      setPreview(json);
      setConfirmOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/storage/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: preview.percent, mode: permanent ? "permanent" : "quarantine" }),
      });
      const json = await res.json() as CleanupResult;
      if (!res.ok || !json.ok) {
        throw new Error(json.message ?? json.error ?? t("storage.cleanup.cleanupFailed"));
      }
      setConfirmOpen(false);
      setPreview(null);
      setPermanent(false);
      setStatus(
        permanent
          ? t("storage.cleanup.donePermanent", { count: String(json.count), size: formatBytes(json.bytes, locale) })
          : t("storage.cleanup.doneQuarantine", { count: String(json.count), size: formatBytes(json.bytes, locale) }),
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="storage-cleanup-title">
      <h3 id="storage-cleanup-title" className="panel-title">{t("storage.cleanup.title")}</h3>
      <p className="muted" style={{ marginTop: 4 }}>{t("storage.cleanup.help")}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 220px" }}>
          <span className="muted">{t("storage.cleanup.percent", { percent: String(percent) })}</span>
          <input
            type="range"
            min={1}
            max={100}
            value={percent}
            onChange={e => setPercent(Number(e.target.value))}
            disabled={busy}
            style={{ flex: 1 }}
            aria-label={t("storage.cleanup.slider")}
          />
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          {PRESETS.map(p => (
            <button
              key={p}
              type="button"
              className={`btn btn-ghost btn-sm${percent === p ? " active" : ""}`}
              disabled={busy}
              onClick={() => setPercent(p)}
            >
              {p}%
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void runPreview()}>
          {t("storage.cleanup.preview")}
        </button>
      </div>

      {status && <p className="muted" style={{ marginTop: 12 }}>{status}</p>}
      {error && <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p>}

      {confirmOpen && preview && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="storage-cleanup-confirm-title"
          onClick={() => !busy && setConfirmOpen(false)}
        >
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 id="storage-cleanup-confirm-title">{t("storage.cleanup.confirmTitle")}</h3>
            <p>
              {t("storage.cleanup.confirmBody", {
                count: String(preview.count),
                size: formatBytes(preview.bytes, locale),
                percent: String(preview.percent),
              })}
            </p>
            {preview.candidates.length > 0 && (
              <ul className="mono muted" style={{ maxHeight: 160, overflow: "auto", fontSize: "var(--text-caption)" }}>
                {preview.candidates.slice(0, 8).map(c => (
                  <li key={c.relPath}>{c.relPath}</li>
                ))}
                {preview.candidates.length > 8 && (
                  <li>{t("storage.cleanup.moreFiles", { n: String(preview.candidates.length - 8) })}</li>
                )}
              </ul>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <input
                type="checkbox"
                checked={permanent}
                disabled={busy}
                onChange={e => setPermanent(e.target.checked)}
              />
              <span>{t("storage.cleanup.permanent")}</span>
            </label>
            <p className="muted" style={{ marginTop: 8, fontSize: "var(--text-caption)" }}>
              {permanent ? t("storage.cleanup.permanentWarn") : t("storage.cleanup.quarantineNote")}
            </p>
            <div className="dialog-actions" style={{ marginTop: 16 }}>
              <button
                ref={cancelRef}
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
              >
                {t("storage.cleanup.cancel")}
              </button>
              <button
                type="button"
                className={permanent ? "btn btn-danger" : "btn"}
                disabled={busy || preview.count === 0}
                onClick={() => void runCleanup()}
              >
                {permanent ? t("storage.cleanup.confirmPermanent") : t("storage.cleanup.confirmQuarantine")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Storage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const loadGenerationRef = useRef(0);

  const fetchStorage = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/storage`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const json = await res.json() as StorageReport;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(json);
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(null);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetchStorage(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [fetchStorage]);

  const failed = !loading && (!data || data.error !== undefined);
  const empty = !loading && !failed && data!.total.fileCount === 0;
  const archivedCount = data?.buckets.find(b => b.key === "archived_sessions")?.fileCount ?? 0;

  return (
    <>
      <div className="page-head">
        <h2 id="storage-page-title">{t("storage.title")}</h2>
        <button type="button" className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void fetchStorage()}>
          <IconRefresh /> {t("storage.refresh")}
        </button>
      </div>
      <p className="page-sub">{t("storage.subtitle")}</p>

      {loading && !data ? (
        <EmptyState title={t("storage.loading")} />
      ) : failed ? (
        <EmptyState title={t("storage.error")} />
      ) : empty ? (
        <EmptyState title={t("storage.empty")} />
      ) : (
        <>
          <div className="usage-cards">
            <div className="stat"><div className="muted">{t("storage.card.total")}</div><div className="stat-value">{formatBytes(data!.total.bytes, locale)}</div></div>
            <div className="stat"><div className="muted">{t("storage.card.files")}</div><div className="stat-value">{data!.total.fileCount.toLocaleString(locale)}</div></div>
            <div className="stat"><div className="muted">{t("storage.card.home")}</div><div className="stat-value mono" style={{ fontSize: "var(--text-body)", wordBreak: "break-all" }}>{data!.codexHome}</div></div>
          </div>
          <BucketsTable buckets={data!.buckets} locale={locale} t={t} />
          <LargestFilesPanel buckets={data!.buckets} locale={locale} t={t} />
          {archivedCount > 0 && (
            <ArchivedCleanupPanel
              apiBase={apiBase}
              locale={locale}
              t={t}
              onDone={() => void fetchStorage()}
            />
          )}
        </>
      )}
    </>
  );
}
