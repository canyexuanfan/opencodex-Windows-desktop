import type { TFn } from "../../i18n";
import { IconExternal, IconLink, IconLock } from "../../icons";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean; needsReauth?: boolean; activeAccountId?: string | null }

export interface OAuthPanelProps {
  t: TFn;
  oauthProviders: string[];
  keyProviders: string[];
  oauthStatus: Record<string, OAuthStatus>;
  busy: string | null;
  loginInfo: { provider: string; url?: string; instructions?: string; deviceCode?: string } | null;
  linkCopied: boolean;
  deviceCodeCopied: boolean;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  config: Config | null;
  setAdding: (v: boolean) => void;
  setLinkCopied: (v: boolean) => void;
  setDeviceCodeCopied: (v: boolean) => void;
  setManualCode: (v: string) => void;
  requestLoginOAuth: (provider: string) => void;
  cancelLoginOAuth: (provider: string) => void;
  logoutOAuth: (provider: string) => void;
  submitManualCode: (provider: string) => void;
  providerIconSrc: (name: string) => string | undefined;
  oauthLabel: (id: string) => string;
}

export function OAuthPanel({
  t, oauthProviders, keyProviders, oauthStatus, busy, loginInfo, linkCopied,
  deviceCodeCopied, manualCode, manualCodeBusy, manualCodeMsg, config, setAdding,
  setLinkCopied, setDeviceCodeCopied, setManualCode, requestLoginOAuth,
  cancelLoginOAuth, logoutOAuth, submitManualCode, providerIconSrc, oauthLabel,
}: OAuthPanelProps) {
  return (
    <div className="panel panel-accent" style={{ marginBottom: 18 }}>
      <div className="row" style={{ marginBottom: 14 }}>
        <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
        <span className="font-semibold">{t("prov.accountLogin")}</span>
      </div>
      <div className="oauth-grid">
        {oauthProviders.length === 0 && keyProviders.length === 0 && (
          <span className="muted text-control" style={{ gridColumn: "1 / -1" }}>{t("prov.noOauth")}</span>
        )}
        {oauthProviders.map(p => {
          const st = oauthStatus[p] ?? { loggedIn: false };
          const isBusy = busy === p;
          const icon = providerIconSrc(p);
          return (
            <div key={p} className="oauth-row">
              <span className="oauth-name" title={oauthLabel(p)}>
                <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                <span className="oauth-name-text">{p}</span>
              </span>
              <span className="oauth-status">
                <span className={`dot ${st.loggedIn ? "dot-green" : "dot-muted"}`} />
                {st.loggedIn ? (
                  <span className="oauth-email" style={{ color: "var(--green)" }}>{st.email ?? t("prov.loggedIn")}</span>
                ) : (
                  <span className="oauth-email muted">{t("prov.notLoggedIn")}</span>
                )}
              </span>
              <span className="oauth-actions">
                {st.loggedIn ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => logoutOAuth(p)}>{t("prov.logout")}</button>
                ) : isBusy ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => { void cancelLoginOAuth(p); }}>{t("common.cancel")}</button>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => requestLoginOAuth(p)} disabled={isBusy}>
                    {isBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconLock />{t("prov.login")}</>}
                  </button>
                )}
              </span>
              {loginInfo?.provider === p && (loginInfo.url || loginInfo.instructions || loginInfo.deviceCode || isBusy) && (
                <span className="oauth-login-hint muted">
                  {loginInfo.deviceCode && (
                    <span className="oauth-device-code-wrap">
                      <span className="oauth-device-code-label">{t("prov.deviceCode")}</span>
                      <code className="oauth-device-code">{loginInfo.deviceCode}</code>
                      <button className="btn btn-primary btn-sm" type="button" onClick={() => {
                        navigator.clipboard.writeText(loginInfo.deviceCode ?? "").then(() => {
                          setDeviceCodeCopied(true);
                          setTimeout(() => setDeviceCodeCopied(false), 2500);
                        }).catch(() => {});
                      }}>{deviceCodeCopied ? t("prov.codeCopied") : t("prov.copyCode")}</button>
                    </span>
                  )}
                  <span className="oauth-login-hint-links">
                    {loginInfo.url && <a href={loginInfo.url} target="_blank" rel="noreferrer" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconExternal width={14} height={14} />{t("prov.didntOpen")}</a>}
                    <button className="link-btn" onClick={() => {
                      if (loginInfo?.url) {
                        navigator.clipboard.writeText(loginInfo.url).then(() => {
                          setLinkCopied(true);
                          setTimeout(() => setLinkCopied(false), 2500);
                        }).catch(() => {});
                      }
                    }} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <IconLink width={14} height={14} />{linkCopied ? t("prov.linkCopied") : t("prov.copyLink")}
                    </button>
                    {loginInfo.instructions && !loginInfo.deviceCode && <span>{loginInfo.instructions}</span>}
                    {isBusy && (
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => void cancelLoginOAuth(p)}>
                        {t("common.cancel")}
                      </button>
                    )}
                  </span>
                  <span className="oauth-login-paste">
                    <input
                      className="input"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={manualCode}
                      onChange={e => setManualCode(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitManualCode(p); } }}
                      placeholder={t("prov.pasteRedirect")}
                      aria-label={t("prov.pasteRedirect")}
                      disabled={manualCodeBusy}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      disabled={manualCodeBusy || !manualCode.trim()}
                      onClick={() => void submitManualCode(p)}
                    >
                      {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                    </button>
                  </span>
                  <span className="text-caption">{manualCodeMsg || t("prov.pasteRedirectHint")}</span>
                </span>
              )}
            </div>
          );
        })}
        {keyProviders.map(name => {
          const provider = config?.providers[name];
          const icon = providerIconSrc(name);
          const keylessFree = provider?.keyOptional === true && !provider?.hasApiKey;
          const missingOpenAiKey = name === "openai-apikey" && !provider?.hasApiKey;
          return (
            <div key={name} className="oauth-row">
              <span className="oauth-name" title={name}>
                <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                <span className="oauth-name-text">{name}</span>
              </span>
              <span className="oauth-status">
                <span className={`dot ${missingOpenAiKey ? "dot-amber" : "dot-green"}`} />
                <span className="oauth-email muted">{missingOpenAiKey ? t("prov.openaiApiMissing") : keylessFree ? t("modal.badge.free") : t("prov.hasApiKey")}</span>
              </span>
              <span className="oauth-actions">
                {missingOpenAiKey && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>{t("prov.openaiApiSetup")}</button>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
