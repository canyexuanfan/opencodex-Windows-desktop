import { useCallback, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { navigateHash } from "../../hash-routing";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import RestoreDialog from "./RestoreDialog";
import {
  FILE_INTEGRATION_CLIENTS,
  IntegrationApiError,
  loadIntegrationJournal,
  loadIntegrationStates,
  toggleIntegration,
  type FileIntegrationClientId,
  type IntegrationJournalRow,
  type IntegrationStatus,
} from "./integration-api";

const TAB_LABEL_KEY: Record<FileIntegrationClientId, TKey> = {
  opencode: "integrations.tab.opencode",
  pi: "integrations.tab.pi",
  hermes: "integrations.tab.hermes",
  openclaw: "integrations.tab.openclaw",
  kimi: "integrations.tab.kimi",
  gajae: "integrations.tab.gajae",
};

function isApplied(status: IntegrationStatus): boolean {
  return status.state === "current" || status.state === "stale";
}

export default function IntegrationsOverview({
  apiBase,
  active = true,
}: {
  apiBase: string;
  active?: boolean;
}) {
  const t = useT();
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [restoring, setRestoring] = useState<IntegrationJournalRow | null>(null);

  const fetchStates = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationStates(apiBase, signal)).clients,
    [apiBase],
  );
  const fetchHistory = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationJournal(apiBase, undefined, signal)).operations,
    [apiBase],
  );

  const statesResource = useDataSurface<IntegrationStatus[]>(
    `integration-states:${apiBase}`,
    [apiBase],
    fetchStates,
    { isEmpty: rows => rows.length === 0, enabled: active },
  );
  const historyResource = useDataSurface<IntegrationJournalRow[]>(
    `integration-journal-all:${apiBase}`,
    [apiBase],
    fetchHistory,
    { isEmpty: rows => rows.length === 0, enabled: active },
  );

  const clients = statesResource.state.data ?? [];
  const history = historyResource.state.data ?? [];
  const installed = clients.filter(client => client.installed);
  const appliedClients = clients.filter(isApplied);
  const staleCount = clients.filter(client => client.state === "stale").length;

  const refresh = () => {
    void statesResource.refresh();
    void historyResource.refresh();
  };

  /*
   * There is deliberately no bulk route. Disabling sequences the same
   * single-client PUT the card uses, so every client gets its own snapshot and
   * its own journal row, and one refusal cannot silently swallow the rest.
   */
  const disableAll = async () => {
    if (bulkPending || appliedClients.length === 0) return;
    if (!confirm(t("integrations.bulk.body"))) return;
    setBulkPending(true);
    setBulkResult(null);
    const failed: string[] = [];
    for (const client of appliedClients) {
      try {
        await toggleIntegration(apiBase, client.clientId, false);
      } catch (error) {
        // Report which clients survived rather than a single opaque failure:
        // a partial result the user cannot see is worse than none.
        failed.push(error instanceof IntegrationApiError
          ? `${client.clientId} (${error.refusal?.message ?? error.message})`
          : client.clientId);
      }
    }
    setBulkPending(false);
    setBulkResult(failed.length === 0
      ? { tone: "ok", text: t("integrations.bulk.success") }
      : { tone: "err", text: t("integrations.bulk.partial", { clients: failed.join(", ") }) });
    refresh();
  };

  const lastChange = history[0]?.at;

  return (
    <section className="integrations-overview">
      <div className="integration-summary">
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.detected")}</span>
          <strong>{installed.length}</strong>
        </div>
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.applied")}</span>
          <strong>{appliedClients.length}</strong>
        </div>
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.stale")}</span>
          <strong>{staleCount}</strong>
        </div>
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.lastChange")}</span>
          <strong>{lastChange ? new Date(lastChange).toLocaleString() : t("integrations.status.unknown")}</strong>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void disableAll()}
          disabled={bulkPending || appliedClients.length === 0}
        >
          {t("integrations.summary.disableAll")}
        </button>
      </div>

      <p className="page-sub">{t("integrations.onboarding")}</p>
      {statesResource.state.kind === "failed-cold" && (
        <Notice tone="err">{t("integrations.error.load")}</Notice>
      )}
      {/*
        A refresh that failed while older values are still on screen is a
        different sentence: the numbers below are real but may be behind.
      */}
      {statesResource.state.kind === "failed-with-stale" && (
        <Notice tone="err">{t("integrations.error.stale")}</Notice>
      )}
      {bulkResult && <Notice tone={bulkResult.tone}>{bulkResult.text}</Notice>}

      {installed.length === 0 ? (
        <div className="integration-empty">
          <h4>{t("integrations.empty.title")}</h4>
          <p>{t("integrations.empty.body")}</p>
        </div>
      ) : (
        <ul className="integration-cards">
          {FILE_INTEGRATION_CLIENTS.map(clientId => {
            const status = clients.find(candidate => candidate.clientId === clientId);
            if (!status) return null;
            return (
              <li key={clientId} className="integration-card">
                <div className="integration-card-head">
                  <h4>{t(TAB_LABEL_KEY[clientId])}</h4>
                  <IntegrationStateBadge state={status.state} installed={status.installed} />
                </div>
                <p className="integration-path">{status.configPath}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => navigateHash(`integrations/${clientId}`)}
                >
                  {t("integrations.action.settings")}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h4>{t("integrations.rollback.title")}</h4>
      {history.length === 0 ? (
        <div className="integration-empty">
          <p>{t("integrations.rollback.empty")}</p>
          <p className="page-sub">{t("integrations.rollback.emptyBody")}</p>
        </div>
      ) : (
        <ul className="integration-history">
          {history.map(row => (
            <li key={row.opId}>
              <span className="integration-history-kind">{row.kind}</span>
              <span className="integration-history-client">{row.clientId}</span>
              <span className="integration-history-at">{new Date(row.at).toLocaleString()}</span>
              {row.snapshot === "expired" ? (
                <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
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
