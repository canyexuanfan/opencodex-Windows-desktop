import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  putCodexPoolStrategy,
  type AccountPoolStrategy,
} from "../account-pool-strategy";
import AccountPoolStrategyControls from "./AccountPoolStrategyControls";
import type { CodexAccountLoadObserver } from "../hooks/useCodexAccountPool";

function strategyFieldsFromActive(value: unknown): {
  strategy: AccountPoolStrategy;
  stickyLimit: number;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!("accountPoolStrategy" in row) && !("accountPoolStickyLimit" in row)) return null;
  return {
    strategy: normalizeAccountPoolStrategy(row.accountPoolStrategy),
    stickyLimit: normalizeAccountPoolStickyLimit(row.accountPoolStickyLimit),
  };
}

/**
 * Codex account-pool rotation strategy controls.
 * Prefers the shared /active read from the account-pool controller (no blocked wait).
 * Falls back to its own GET only when no shared observer is wired.
 */
export default function CodexPoolStrategySetting({
  apiBase,
  subscribeLoadObserver,
  readLastActive,
}: {
  apiBase: string;
  subscribeLoadObserver?: (observer: CodexAccountLoadObserver) => () => void;
  readLastActive?: () => unknown;
}) {
  const t = useT();
  // Seed defaults immediately — never gate the control chrome on a network round-trip.
  const [strategy, setStrategy] = useState<AccountPoolStrategy>(DEFAULT_ACCOUNT_POOL_STRATEGY);
  const [stickyLimit, setStickyLimit] = useState(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const revisionRef = useRef(0);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyServer = useCallback((json: {
    accountPoolStrategy?: unknown;
    accountPoolStickyLimit?: unknown;
  }) => {
    const nextStrategy = normalizeAccountPoolStrategy(json.accountPoolStrategy);
    const nextSticky = normalizeAccountPoolStickyLimit(json.accountPoolStickyLimit);
    setStrategy(nextStrategy);
    setStickyLimit(nextSticky);
    setStickyDraft(String(nextSticky));
    hydratedRef.current = true;
    setHydrated(true);
    setLoadError(false);
    setError(null);
  }, []);

  const applyActivePayload = useCallback((value: unknown) => {
    const fields = strategyFieldsFromActive(value);
    if (!fields) return;
    applyServer({
      accountPoolStrategy: fields.strategy,
      accountPoolStickyLimit: fields.stickyLimit,
    });
  }, [applyServer]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/codex-auth/active`);
      if (!res.ok) throw new Error("load");
      applyServer(await res.json() as {
        accountPoolStrategy?: unknown;
        accountPoolStickyLimit?: unknown;
      });
    } catch {
      setLoadError(true);
    }
  }, [apiBase, applyServer]);

  // Shared /active observer (preferred): same payload the pool already fetched.
  // Ignore stale polls that started before a PUT bumped revision, and never apply while saving.
  useEffect(() => {
    if (!subscribeLoadObserver) return;
    const observer: CodexAccountLoadObserver = {
      beginActiveRead: () => revisionRef.current,
      acceptActiveRead: (value, startedRevision) => {
        if (startedRevision !== revisionRef.current) return;
        if (savingRef.current) return;
        applyActivePayload(value);
      },
      rejectActiveRead: () => {
        if (!hydratedRef.current) setLoadError(true);
      },
    };
    return subscribeLoadObserver(observer);
  }, [subscribeLoadObserver, applyActivePayload]);

  useEffect(() => {
    if (!readLastActive) return;
    if (savingRef.current) return;
    applyActivePayload(readLastActive());
  }, [readLastActive, applyActivePayload]);

  // Standalone fallback when no shared controller observer is wired (keeps tests without observer green).
  useEffect(() => {
    if (subscribeLoadObserver) return;
    void load();
  }, [load, subscribeLoadObserver]);

  const save = useCallback(async (next: {
    strategy?: AccountPoolStrategy;
    stickyLimit?: number;
  }) => {
    if (savingRef.current) return;
    const previousStrategy = strategy;
    const previousSticky = stickyLimit;
    if (next.strategy !== undefined) setStrategy(next.strategy);
    if (next.stickyLimit !== undefined) {
      setStickyLimit(next.stickyLimit);
      setStickyDraft(String(next.stickyLimit));
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    revisionRef.current += 1;
    const result = await putCodexPoolStrategy(apiBase, next);
    revisionRef.current += 1;
    if (result.ok) {
      setStrategy(result.strategy);
      setStickyLimit(result.stickyLimit);
      setStickyDraft(String(result.stickyLimit));
      hydratedRef.current = true;
      setHydrated(true);
    } else {
      setError(t("accountPool.strategyUpdateFailed"));
      setStrategy(previousStrategy);
      setStickyLimit(previousSticky);
      setStickyDraft(String(previousSticky));
    }
    savingRef.current = false;
    setSaving(false);
  }, [apiBase, stickyLimit, strategy, t]);

  // Block writes until /active confirms — defaults paint for CLS but must not overwrite server state.
  const controlsDisabled = saving || loadError || !hydrated;

  return (
    <div className="card account-pool-strategy-card" aria-busy={saving || (!hydrated && !loadError)}>
      <strong>{t("accountPool.strategy")}</strong>
      <div className="card-sub" role={loadError ? "alert" : undefined}>
        {loadError
          ? t("accountPool.strategyLoadFailed")
          : t("accountPool.strategyDesc")}
      </div>
      {loadError && (
        <button type="button" className="btn btn-ghost btn-sm account-pool-strategy-card__retry" onClick={() => { void load(); }}>
          {t("common.retry")}
        </button>
      )}
      {!loadError && (
        <AccountPoolStrategyControls
          strategy={strategy}
          stickyDraft={stickyDraft}
          disabled={controlsDisabled}
          strategySelectId="codex-pool-strategy"
          stickyInputId="codex-pool-sticky-limit"
          strategyLabelHidden
          onStrategyChange={(next) => {
            if (controlsDisabled || next === strategy) return;
            void save({ strategy: next });
          }}
          onStickyDraftChange={setStickyDraft}
          onStickyCommit={() => {
            if (controlsDisabled) return;
            const parsed = parseAccountPoolStickyLimitDraft(stickyDraft);
            if (parsed === null) {
              setStickyDraft(String(stickyLimit));
              setError(t("accountPool.stickyLimitInvalid"));
              return;
            }
            if (parsed === stickyLimit) {
              setStickyDraft(String(parsed));
              return;
            }
            void save({ stickyLimit: parsed });
          }}
        />
      )}
      {error && (
        <div role="alert" className="card-sub account-pool-strategy-card__error">
          {error}
        </div>
      )}
    </div>
  );
}
