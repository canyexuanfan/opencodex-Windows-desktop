import { useEffect, useRef, useState } from "react";
import { IconExternal, IconLink, IconLock } from "../icons";
import { useT } from "../i18n/shared";
import { copyTextToClipboard } from "../oauth-health-display";
import type { CatalogPreset } from "./provider-catalog/provider-presets";

export function AddProviderOAuthPane({
  preset,
  oauthSupported,
  oauthBusy,
  oauthMsg,
  oauthMsgTone,
  oauthUrl,
  manualCode,
  manualCodeBusy,
  manualCodeMsg,
  manualCodeOk,
  onRequestLogin,
  onUseApiKeyInstead,
  onManualCodeChange,
  onSubmitManualCode,
  onBack,
}: {
  preset: CatalogPreset;
  oauthSupported: string[];
  oauthBusy: boolean;
  oauthMsg: string;
  oauthMsgTone: "ok" | "warn";
  oauthUrl: string;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  manualCodeOk: boolean;
  onRequestLogin: (providerId: string) => void;
  onUseApiKeyInstead: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: (providerId: string) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [linkCopyState, setLinkCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const linkCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (linkCopyTimer.current) clearTimeout(linkCopyTimer.current); }, []);

  const copyAuthUrl = () => {
    void copyTextToClipboard(oauthUrl).then((ok) => {
      setLinkCopyState(ok ? "copied" : "unavailable");
      if (linkCopyTimer.current) clearTimeout(linkCopyTimer.current);
      linkCopyTimer.current = setTimeout(() => {
        linkCopyTimer.current = null;
        setLinkCopyState("idle");
      }, 2500);
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="muted text-control">{preset.note ?? t("modal.oauthDefaultNote")}</div>
      {oauthSupported.includes(preset.oauthProvider ?? "") ? (
        <button type="button" className="btn btn-primary" onClick={() => onRequestLogin(preset.oauthProvider!)} disabled={oauthBusy}
          style={{ width: "100%", padding: "12px 16px" }}>
          <IconLock />{oauthBusy ? t("modal.waitingBrowser") : t("modal.logInWith", { label: preset.label })}
        </button>
      ) : (
        <div className="text-control" style={{ color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
          {t("modal.oauthComingSoon", { label: preset.label })}
        </div>
      )}
      {oauthMsg && (
        <div className="text-label" style={{ color: oauthMsgTone === "warn" ? "var(--amber)" : "var(--accent-hover)" }}>
          {oauthMsg}
        </div>
      )}
      {oauthBusy && oauthUrl && (
        <div className="pwi-auth-url-wrap">
          <code className="pwi-auth-url">{oauthUrl}</code>
          <div className="pwi-auth-url-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={copyAuthUrl}>
              <IconLink style={{ width: 13, height: 13 }} aria-hidden="true" />
              <span aria-live="polite">
                {linkCopyState === "copied"
                  ? t("prov.linkCopied")
                  : linkCopyState === "unavailable"
                    ? t("prov.linkCopyUnavailable")
                    : t("prov.copyLink")}
              </span>
            </button>
            <a href={oauthUrl} target="_blank" rel="noreferrer" className="pwi-auth-open-link">
              <IconExternal style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.didntOpen")}
            </a>
          </div>
        </div>
      )}
      {oauthBusy && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="muted text-label">
            {t("prov.pasteRedirectHint")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={manualCode}
              onChange={e => onManualCodeChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && preset.oauthProvider) {
                  e.preventDefault();
                  onSubmitManualCode(preset.oauthProvider);
                }
              }}
              placeholder={t("prov.pasteRedirect")}
              aria-label={t("prov.pasteRedirect")}
              disabled={manualCodeBusy}
              className="input text-label"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-ghost"
              type="button"
              disabled={manualCodeBusy || !manualCode.trim() || !preset.oauthProvider}
              onClick={() => preset.oauthProvider && onSubmitManualCode(preset.oauthProvider)}
            >
              {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
            </button>
          </div>
          {manualCodeMsg && (
            <div className="text-label" style={{ color: manualCodeOk ? "var(--accent-hover)" : "var(--amber)" }}>
              {manualCodeMsg}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
        <button type="button" className="link-btn" onClick={onUseApiKeyInstead}>
          {t("modal.useApiKeyInstead")}
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("modal.back")}</button>
      </div>
    </div>
  );
}
