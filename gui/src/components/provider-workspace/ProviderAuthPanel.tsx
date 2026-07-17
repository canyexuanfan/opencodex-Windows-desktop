/**
 * ProviderAuthPanel — OAuth accounts, API-key pool, and forward-auth
 * embedding for the workspace Settings tab (WP091). Consumes WP040+WP060
 * handlers via props-down; no internal auth machinery.
 */
import { useState } from "react";
import { useT } from "../../i18n";
import { IconLock, IconExternal, IconTrash } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { isLocalProvider } from "../../provider-workspace/kind";
import { authModeLabel } from "./ProviderRail";
import CodexAccountPool from "../CodexAccountPool";
import type { OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers } from "./types";

export default function ProviderAuthPanel({
  item, apiBase, oauth, accounts = [], keys = [], busy = false, loginHint, authHandlers,
}: {
  item: WorkspaceItem;
  apiBase: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  busy?: boolean;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
}) {
  const t = useT();
  const [addingKey, setAddingKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  const mode = (item.authMode ?? "").toLowerCase();
  const isOauth = mode === "oauth";
  const isForward = mode === "forward";
  const isLocal = mode === "local" || isLocalProvider(item);
  const isKeyOptional = item.keyOptional === true;
  const hasKeyMaterial = item.hasApiKey === true || keys.length > 0;
  const isKeyAuth =
    (mode === "key" || (!isOauth && !isForward && !isLocal) || item.hasApiKey === true) &&
    !(isKeyOptional && !hasKeyMaterial);

  if (isForward) {
    return (
      <section className="pwi-section pwi-auth-section" aria-label={t("pws.availableAccounts")}>
        <h3 className="pwi-section-title">{t("pws.availableAccounts")}</h3>
        <div className="pwi-auth-body">
          <CodexAccountPool apiBase={apiBase} embedded />
        </div>
      </section>
    );
  }

  if (!authHandlers) return null;
  if (!isOauth && !isKeyAuth && !isLocal) return null;

  const hintForThis = loginHint?.provider === item.name ? loginHint : null;

  const submitKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    setKeyBusy(true);
    const ok = await authHandlers.onAddApiKey(item.name, key);
    setKeyBusy(false);
    if (ok) { setNewKey(""); setAddingKey(false); }
  };

  return (
    <section className="pwi-section pwi-auth-section" aria-label={isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}>
      <h3 className="pwi-section-title">{isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}</h3>
      <div className="pwi-auth-body">
        {isOauth && (
          <>
            <div className="pwi-auth-status-row">
              <span className={`pwi-auth-dot ${oauth?.loggedIn ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} />
              <span className="pwi-auth-status-text">
                {oauth?.loggedIn
                  ? (accounts.length > 0 ? t("pws.loggedInTitle") : (oauth.email ?? t("pws.loggedInTitle")))
                  : (oauth?.error || t("pws.notLoggedInTitle"))}
              </span>
              <span className="pwi-auth-actions">
                {oauth?.loggedIn ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => authHandlers.onLogout(item.name)}>{t("prov.logout")}</button>
                ) : busy ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => authHandlers.onCancelLogin?.(item.name)}>{t("common.cancel")}</button>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => authHandlers.onLogin(item.name, false)}>
                    <IconLock style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.login")}
                  </button>
                )}
              </span>
            </div>
            {busy && hintForThis && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
                  {hintForThis.url && (
                    <a href={hintForThis.url} target="_blank" rel="noreferrer" className="pwi-auth-open-link">
                      <IconExternal style={{ width: 13, height: 13 }} /> {t("prov.didntOpen")}
                    </a>
                  )}
                </div>
              </div>
            )}
            {accounts.length > 0 && (
              <div className="pwi-auth-list" role="list">
                {accounts.map(account => (
                  <div key={account.id} className={`pwi-auth-row${account.active ? " pwi-auth-row--active" : ""}`} role="listitem">
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => authHandlers.onSwitchAccount(item.name, account)}
                      disabled={account.active}>
                      <span className={`pwi-auth-dot ${account.needsReauth ? "pwi-auth-dot--warn" : account.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} />
                      <span className="pwi-auth-row-label">{account.email ?? account.id}</span>
                      {account.needsReauth && <span className="badge badge-amber">{t("pws.reauth")}</span>}
                      {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      onClick={() => authHandlers.onRemoveAccount(item.name, account)}>
                      <IconTrash style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {oauth?.loggedIn && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                onClick={() => authHandlers.onLogin(item.name, true)}>
                {t("pws.addAccount")}
              </button>
            )}
          </>
        )}

        {isKeyAuth && (
          <>
            {keys.length > 0 && (
              <div className="pwi-auth-list" role="list">
                {keys.map(entry => (
                  <div key={entry.id} className={`pwi-auth-row${entry.active ? " pwi-auth-row--active" : ""}`} role="listitem">
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => authHandlers.onSwitchApiKey(item.name, entry)}
                      disabled={entry.active}>
                      <span className={`pwi-auth-dot ${entry.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} />
                      <code className="pwi-auth-row-label">{entry.masked}</code>
                      {entry.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      onClick={() => authHandlers.onRemoveApiKey(item.name, entry)}>
                      <IconTrash style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {addingKey ? (
              <div className="pwi-auth-add-key">
                <input className="input" type="password" value={newKey} onChange={e => setNewKey(e.target.value)}
                  placeholder={t("modal.apiKeyPlaceholder")} autoComplete="off" disabled={keyBusy} />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitKey()} disabled={keyBusy || !newKey.trim()}>
                  {keyBusy ? t("pws.saving") : t("pws.addKey")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAddingKey(false); setNewKey(""); }}>{t("common.cancel")}</button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                onClick={() => setAddingKey(true)}>{t("pws.addKey")}</button>
            )}
          </>
        )}

        {isLocal && !isKeyAuth && (
          <div className="pwi-auth-status-row">
            <span className="pwi-auth-dot pwi-auth-dot--ok" />
            <span className="pwi-auth-status-text">{t("modal.badge.local")} — {authModeLabel(item, t)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
