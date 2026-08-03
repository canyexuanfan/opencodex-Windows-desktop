import { useCallback, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { navigateHash } from "../../hash-routing";
import { useT, type TKey } from "../../i18n/shared";
import { Notice, Switch } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import RestoreDialog from "./RestoreDialog";
import { describeRefusal } from "./refusal-copy";
import {
  buildOverviewRows,
  countOverviewRows,
  type OverviewRow,
} from "./overview-clients";
import {
  loadApiKeyCount,
  loadClaudeCodeStatus,
  loadClaudeDesktopStatus,
  loadCodexRoutingStatus,
  loadGrokFenceStatus,
  loadIntegrationJournal,
  loadIntegrationStates,
  toggleIntegration,
  type FileIntegrationClientId,
  type IntegrationJournalRow,
  type IntegrationStatus,
} from "./integration-api";

const KIND_KEY: Record<IntegrationJournalRow["kind"], TKey> = {
  apply: "integrations.kind.apply",
  disable: "integrations.kind.disable",
  refresh: "integrations.kind.refresh",
  restore: "integrations.kind.restore",
};

function isApplied(status: IntegrationStatus): boolean {
  return status.state === "current" || status.state === "stale";
}

/**
 * One card, whether or not its client has a switch.
 *
 * The whole card navigates, but it is NOT a button or an anchor: it already
 * holds two controls, and nesting them inside one is invalid and takes the
 * switch off the keyboard. Instead the title is the real control and a
 * pseudo-element stretches it over the card, with the two action controls
 * lifted above it in the stacking order. That gives one tab stop named after
 * the client, leaves the switch and the settings button clickable on their
 * own, and needs no `stopPropagation` guessing about which control the user
 * meant. The badge is deliberately NOT lifted — it is not interactive, and
 * lifting it would carve a dead zone into the middle of a clickable card.
 */
function OverviewCard({
  row,
  pending,
  onOpen,
  onToggle,
}: {
  row: OverviewRow;
  pending: boolean;
  onOpen: () => void;
  onToggle: (() => void) | null;
}) {
  const t = useT();
  const status = row.status;
  const applied = status ? isApplied(status) : false;
  const detail = row.detail ?? (row.detailKey ? t(row.detailKey, row.detailVars ?? undefined) : null);
  return (
    <li className="integration-card" data-client={row.id}>
      <div className="integration-card-head">
        <h4>
          <button type="button" className="integration-card-link" onClick={onOpen}>
            {t(row.labelKey)}
          </button>
        </h4>
        <IntegrationStateBadge state={row.state} installed={row.installed} />
      </div>
      {/*
        File clients show a config path in code type, because that is a string
        the user copies. The rest show a translated sentence, which must not
        pretend to be a path.
      */}
      {detail && (
        <p className={row.detail ? "integration-path" : "integration-meta"}>{detail}</p>
      )}
      <div className="integration-card-actions">
        {status && onToggle && (
          <Switch
            on={applied}
            onClick={onToggle}
            // Conflict and unsafe are never resolved from a card: the
            // client page is where the reason is explained.
            disabled={!status.installed
              || status.state === "conflict"
              || status.state === "unsafe"
              || pending}
            label={applied
              ? t("integrations.action.disable")
              : t("integrations.action.apply")}
          />
        )}
        <button type="button" className="btn btn-ghost" onClick={onOpen} tabIndex={-1}>
          {t("integrations.action.settings")}
        </button>
      </div>
    </li>
  );
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
  /*
   * The five surfaces that are not file clients. Each is read ONCE per visit
   * and on an explicit refresh — deliberately no `pollMs`: `/api/claude-code`
   * answers ~36 KB to give up two booleans and `/api/keys` measured 466 ms, so
   * a timer would spend that repeatedly to learn nothing new. `enabled: active`
   * keeps all five quiet while the panel is mounted but hidden.
   */
  const fetchCodex = useCallback(
    (signal: AbortSignal) => loadCodexRoutingStatus(apiBase, signal),
    [apiBase],
  );
  const fetchKeyCount = useCallback(
    (signal: AbortSignal) => loadApiKeyCount(apiBase, signal),
    [apiBase],
  );
  const fetchClaude = useCallback(
    (signal: AbortSignal) => loadClaudeCodeStatus(apiBase, signal),
    [apiBase],
  );
  const fetchClaudeDesktop = useCallback(
    (signal: AbortSignal) => loadClaudeDesktopStatus(apiBase, signal),
    [apiBase],
  );
  const fetchGrok = useCallback(
    (signal: AbortSignal) => loadGrokFenceStatus(apiBase, signal),
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
  const codexResource = useDataSurface(
    `integration-codex:${apiBase}`,
    [apiBase],
    fetchCodex,
    { isEmpty: value => value === null, enabled: active },
  );
  const keysResource = useDataSurface(
    `integration-keys:${apiBase}`,
    [apiBase],
    fetchKeyCount,
    { isEmpty: value => value === null, enabled: active },
  );
  const claudeResource = useDataSurface(
    `integration-claude:${apiBase}`,
    [apiBase],
    fetchClaude,
    { isEmpty: value => value === null, enabled: active },
  );
  const claudeDesktopResource = useDataSurface(
    `integration-claude-desktop:${apiBase}`,
    [apiBase],
    fetchClaudeDesktop,
    { isEmpty: value => value === null, enabled: active },
  );
  const grokResource = useDataSurface(
    `integration-grok:${apiBase}`,
    [apiBase],
    fetchGrok,
    { isEmpty: value => value === null, enabled: active },
  );

  const clients = statesResource.state.data ?? [];
  const history = historyResource.state.data ?? [];
  const appliedClients = clients.filter(isApplied);
  const installedFileClients = clients.filter(client => client.installed);
  /*
   * "Settled" is what separates a client the server omitted from one whose
   * list has not answered yet. Only a cold state means we have never had an
   * answer; a stale-with-error state still holds real rows.
   */
  const clientsSettled = statesResource.state.kind !== "cold"
    && statesResource.state.kind !== "retrying-cold";
  const rows = buildOverviewRows({
    clients,
    clientsSettled,
    codex: codexResource.state.data ?? null,
    keyCount: keysResource.state.data ?? null,
    claude: claudeResource.state.data ?? null,
    claudeDesktop: claudeDesktopResource.state.data ?? null,
    grok: grokResource.state.data ?? null,
  });
  const counts = countOverviewRows(rows);

  /*
   * `refresh()` on the resource layer is deliberately fire-and-forget: it
   * kicks a fetch and stores the error rather than throwing. Awaiting it
   * resolves immediately, so it can only ever repaint the UI — it can never
   * tell a caller whether the new state actually arrived.
   */
  const refresh = () => {
    statesResource.refresh();
    historyResource.refresh();
    codexResource.refresh();
    keysResource.refresh();
    claudeResource.refresh();
    claudeDesktopResource.refresh();
    grokResource.refresh();
  };

  /*
   * There is deliberately no bulk route. Disabling sequences the same
   * single-client PUT the card uses, so every client gets its own snapshot and
   * its own journal row, and one refusal cannot silently swallow the rest.
   */
  const disableAll = async () => {
    if (bulkPending || appliedClients.length === 0) return;
    // Title then body, so the prompt names the action before its consequences.
    const prompt = [t("integrations.bulk.title"), t("integrations.bulk.body")].join("\n\n");
    if (!confirm(prompt)) return;
    setBulkPending(true);
    setBulkResult(null);
    const failed: string[] = [];
    /*
     * Sequential ON PURPOSE — do not convert this to `Promise.all`.
     *
     * The server's single-flight guard is keyed per client, so it does not
     * serialize across different ones, and `writeRecord`/`deleteRecord`
     * read-modify-write a SHARED records.json with no lock. Firing six
     * disables together interleaves those writes and drops an ownership
     * record, which loses the proof that a block is ours — the next disable
     * then refuses as `unowned-key` and the block is stranded in the user's
     * config with nothing claiming it.
     *
     * Six loopback requests are cheap; a lost ownership record is not.
     */
    for (const client of appliedClients) {
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- serial on purpose; see the block comment above
        await toggleIntegration(apiBase, client.clientId, false);
      } catch (error) {
        // Report which clients survived rather than a single opaque failure:
        // a partial result the user cannot see is worse than none.
        // `describeRefusal` keeps the snapshot path and the residual warning,
        // which a bare message would drop for exactly the clients that need
        // manual recovery.
        failed.push(`${client.clientId}: ${describeRefusal(t, error)}`);
      }
    }
    /*
     * Confirm the outcome against the server before claiming it.
     *
     * Announcing success while the cards still read "applied" tells the user
     * two contradictory things at once, and the resource `refresh()` above
     * cannot be awaited for the answer. So re-read the states directly: this
     * one IS awaitable, and it also catches a client the server declined to
     * change without raising an error we would have seen.
     */
    let unsettled = false;
    try {
      const confirmed = await loadIntegrationStates(apiBase);
      unsettled = confirmed.clients.some(isApplied);
    } catch {
      failed.push(t("integrations.error.stale"));
    }
    if (unsettled && failed.length === 0) failed.push(t("integrations.error.stale"));
    refresh();
    setBulkPending(false);
    setBulkResult(failed.length === 0
      ? { tone: "ok", text: t("integrations.bulk.success") }
      : { tone: "err", text: t("integrations.bulk.partial", { clients: failed.join("; ") }) });
  };

  const lastChange = history[0]?.at;

  /*
   * The card carries its own switch. Sending the user to a sub-page to flip
   * one client turns the overview into a directory of links, and the summary
   * counts right above it exist precisely so a user can act on what they see.
   */
  const [cardPending, setCardPending] = useState<FileIntegrationClientId | null>(null);
  const toggleCard = async (client: IntegrationStatus) => {
    if (cardPending) return;
    setCardPending(client.clientId);
    setBulkResult(null);
    try {
      // Same rule as the client page: turning it off means disable, for
      // `stale` as much as for `current`.
      await toggleIntegration(apiBase, client.clientId, !isApplied(client));
      refresh();
    } catch (error) {
      setBulkResult({ tone: "err", text: `${client.clientId}: ${describeRefusal(t, error)}` });
    } finally {
      setCardPending(null);
    }
  };

  return (
    <section className="integrations-overview">
      <div className="integration-summary">
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.detected")}</span>
          <strong>{counts.detected}</strong>
        </div>
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.applied")}</span>
          <strong>{counts.applied}</strong>
        </div>
        <div className="integration-summary-cell">
          <span className="integration-summary-label">{t("integrations.summary.stale")}</span>
          <strong>{counts.stale}</strong>
        </div>
        {/*
          Only shown when something could not be read. A permanent cell reading
          zero is noise; a cell that appears is a signal — and without it, six
          applied out of eleven and six out of nine look identical.
        */}
        {counts.unknown > 0 && (
          <div className="integration-summary-cell">
            <span className="integration-summary-label">{t("integrations.state.unknown")}</span>
            <strong>{counts.unknown}</strong>
          </div>
        )}
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

      {/*
        The grid used to disappear entirely when no FILE client was installed,
        which now means hiding Codex, API keys, Claude and Grok because the
        user has not installed OpenCode. The "nothing detected" panel is about
        the file clients specifically, so it sits BELOW the grid and says so
        instead of replacing everything.
      */}
      {rows.length === 0 ? (
        statesResource.state.kind === "failed-cold" ? null : (
          <p className="page-sub">{t("common.loading")}</p>
        )
      ) : (
        <ul className="integration-cards">
          {rows.map(row => (
            <OverviewCard
              key={row.id}
              row={row}
              pending={cardPending !== null}
              onOpen={() => navigateHash(row.hash)}
              onToggle={row.status ? () => void toggleCard(row.status!) : null}
            />
          ))}
        </ul>
      )}
      {clientsSettled && installedFileClients.length === 0 && (
        <div className="integration-empty">
          <h4>{t("integrations.empty.title")}</h4>
          <p>{t("integrations.empty.body")}</p>
        </div>
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
              <span className="integration-history-kind">{t(KIND_KEY[row.kind])}</span>
              <span className="integration-history-client">{row.clientId}</span>
              <span className="integration-history-at">{new Date(row.at).toLocaleString()}</span>
              {row.snapshot === "expired" ? (
                <span className="badge badge-muted">{t("integrations.action.snapshotExpired")}</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setRestoring(row)}
                >
                  {/* `undoable` picks the wording; the server owns eligibility. */}
                  {row.undoable
                    ? t("integrations.action.undo")
                    : t("integrations.action.restorePoint")}
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
