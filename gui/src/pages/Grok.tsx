import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../ui";
import { useT, type TKey } from "../i18n";

type TFn = (key: TKey, vars?: Record<string, string | number>) => string;

interface GrokStatusModel {
  alias: string;
  id: string;
  contextWindow?: number;
}

interface GrokStatus {
  configPath: string;
  present: boolean;
  baseUrl: string | null;
  models: GrokStatusModel[];
}

/** Same context formatting the Desktop page uses, so the two surfaces read alike. */
function formatContext(value: number | undefined, t: TFn): string {
  if (!value) return "—";
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

/**
 * Read-only view of the Grok Build fence. There is no write control on purpose: the proxy owns
 * every mutation of ~/.grok/config.toml through `ocx start`/`ensure`/`restart`, and this page
 * reports what that produced.
 */
export default function Grok({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [status, setStatus] = useState<GrokStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/grok`);
      const payload = await response.json() as GrokStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error || t("grok.loadFail"));
      setStatus(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("grok.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  // Deferred like the Desktop page: kicking the fetch off synchronously inside the effect
  // triggers cascading renders (and the react-doctor lint that guards against them).
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading) return <section className="grok-page"><p className="page-sub">{t("grok.loading")}</p></section>;

  if (error) {
    return (
      <section className="grok-page">
        <div className="alert alert-err" role="alert">{error}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>{t("common.retry")}</button>
      </section>
    );
  }

  return (
    <section className="grok-page">
      <h2 className="page-title">{t("grok.title")}</h2>
      <p className="page-sub">{t("grok.subtitle")}</p>

      {!status?.present ? (
        // Absent is a normal state, not a failure: Grok simply is not wired up yet. Name the
        // action that wires it rather than leaving an empty panel.
        <EmptyState title={t("grok.notConfiguredTitle")}>
          {t("grok.notConfiguredHint")}
          <br />
          <code>{status?.configPath}</code>
        </EmptyState>
      ) : (
        <>
          <div className="grok-endpoint">
            <span>{t("grok.endpoint")}</span>
            <code>{status.baseUrl ?? "—"}</code>
          </div>
          <p className="page-sub"><code>{status.configPath}</code></p>

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("grok.colModel")}</th>
                  <th>{t("grok.colAlias")}</th>
                  <th>{t("grok.colContext")}</th>
                </tr>
              </thead>
              <tbody>
                {status.models.map(model => (
                  <tr key={model.alias}>
                    <td><code>{model.id}</code></td>
                    <td><code>{model.alias}</code></td>
                    <td>{formatContext(model.contextWindow, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
