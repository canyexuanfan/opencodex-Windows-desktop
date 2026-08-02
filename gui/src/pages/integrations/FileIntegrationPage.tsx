import { useCallback, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { useT, type TKey } from "../../i18n/shared";
import { Notice, Switch } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import RestoreDialog from "./RestoreDialog";
import {
  IntegrationApiError,
  loadIntegrationJournal,
  loadIntegrationState,
  toggleIntegration,
  type FileIntegrationClientId,
  type IntegrationJournalRow,
  type IntegrationStatus,
} from "./integration-api";

export type { FileIntegrationClientId };

const SEMANTICS_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.semantics.opencode",
  pi: "integrations.semantics.pi",
  hermes: "integrations.semantics.hermes",
  openclaw: "integrations.semantics.openclaw",
  kimi: "integrations.semantics.kimi",
  gajae: "integrations.semantics.gajae",
};

const TAB_LABEL_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.tab.opencode",
  pi: "integrations.tab.pi",
  hermes: "integrations.tab.hermes",
  openclaw: "integrations.tab.openclaw",
  kimi: "integrations.tab.kimi",
  gajae: "integrations.tab.gajae",
};

/**
 * Map a refusal to the sentence a user can act on.
 *
 * Keyed on `reason`, never on `state`: a write that failed while the file
 * happened to be in conflict is still a write failure, and choosing the
 * message by state would tell the user to resolve a conflict that is not the
 * thing that went wrong.
 */
function refusalMessageKey(reason: string | undefined): TKey {
  if (reason === "conflict") return "integrations.error.conflict";
  if (reason === "unsafe") return "integrations.error.unsafe";
  return "integrations.error.generic";
}

export default function FileIntegrationPage({
  apiBase,
  client,
  active = true,
}: {
  apiBase: string;
  client: FileIntegrationClientId;
  active?: boolean;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<IntegrationJournalRow | null>(null);

  const fetchState = useCallback(
    (signal: AbortSignal) => loadIntegrationState(apiBase, client, signal),
    [apiBase, client],
  );
  const fetchHistory = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationJournal(apiBase, client, signal)).operations,
    [apiBase, client],
  );

  const stateResource = useDataSurface<IntegrationStatus>(
    `integration-state:${apiBase}:${client}`,
    [apiBase, client],
    fetchState,
    { isEmpty: () => false, enabled: active },
  );
  const historyResource = useDataSurface<IntegrationJournalRow[]>(
    `integration-journal:${apiBase}:${client}`,
    [apiBase, client],
    fetchHistory,
    { isEmpty: rows => rows.length === 0, enabled: active },
  );

  const status = stateResource.state.data ?? null;
  const history = historyResource.state.data ?? [];

  const refresh = () => {
    void stateResource.refresh();
    void historyResource.refresh();
  };

  const toggle = async () => {
    if (!status || pending) return;
    setPending(true);
    setFailure(null);
    try {
      // `current` and `stale` both mean "our block is in the file", so the
      // switch reads applied for either; only `current` needs no rewrite.
      await toggleIntegration(apiBase, client, status.state === "absent" || status.state === "stale");
      refresh();
    } catch (error) {
      const refusal = error instanceof IntegrationApiError ? error.refusal : null;
      const base = t(refusalMessageKey(refusal?.reason));
      setFailure(
        refusal?.snapshotPath
          ? t("integrations.restore.manual", { reason: refusal.message, path: refusal.snapshotPath })
          : refusal?.message
            ? `${base} ${refusal.message}`
            : base,
      );
    } finally {
      setPending(false);
    }
  };

  if (!status) {
    return (
      <section className="integration-client-page">
        {stateResource.state.kind === "failed-cold"
          ? <Notice tone="err">{t("integrations.error.load")}</Notice>
          : <p className="page-sub">{t("common.loading")}</p>}
      </section>
    );
  }

  const applied = status.state === "current" || status.state === "stale";
  // Conflict and unsafe are never auto-resolved: the switch is locked and the
  // user is told why, because the alternative is deleting an edit we do not own.
  const locked = !status.installed || status.state === "conflict" || status.state === "unsafe";

  return (
    <section className="integration-client-page">
      <div className="integration-client-head">
        <h3>{t(TAB_LABEL_KEY[client])}</h3>
        <IntegrationStateBadge
          state={status.state}
          installed={status.installed}
          id={`integration-state-${client}`}
        />
        <Switch
          on={applied}
          onClick={() => void toggle()}
          disabled={locked || pending}
          label={applied ? t("integrations.action.disable") : t("integrations.action.apply")}
        />
      </div>

      <p className="page-sub">{t(SEMANTICS_KEY[client])}</p>
      <p className="integration-path">{status.configPath}</p>

      {status.appliedAt && (
        <p className="integration-meta">
          {t("integrations.status.appliedAt")}: {new Date(status.appliedAt).toLocaleString()}
        </p>
      )}
      {status.retentionDegraded && (
        <Notice tone="err">{t("integrations.retention.degraded")}</Notice>
      )}
      {failure && <Notice tone="err">{failure}</Notice>}

      <h4>{t("integrations.rollback.title")}</h4>
      {history.length === 0 ? (
        <p className="page-sub">{t("integrations.rollback.empty")}</p>
      ) : (
        <ul className="integration-history">
          {history.map(row => (
            <li key={row.opId}>
              <span className="integration-history-kind">{row.kind}</span>
              <span className="integration-history-at">{new Date(row.at).toLocaleString()}</span>
              {row.snapshot === "expired" ? (
                <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  // `undoable` already accounts for an expired snapshot and for
                  // a file edited since; offering the button anyway would call a
                  // route that answers 410.
                  disabled={!row.undoable}
                  onClick={() => setRestoring(row)}
                >
                  {t("integrations.action.restorePoint")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {restoring && (
        <RestoreDialog
          apiBase={apiBase}
          row={restoring}
          onClose={() => setRestoring(null)}
          onRestored={refresh}
        />
      )}
    </section>
  );
}
