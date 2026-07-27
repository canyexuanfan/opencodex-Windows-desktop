import { useCallback, useEffect, useRef, useState } from "react";
import { IconExternal, IconLink } from "../icons";
import { useT } from "../i18n/shared";
import { copyTextToClipboard } from "../oauth-health-display";

const FEEDBACK_MS = 2500;

type CopyState = "idle" | "copied" | "unavailable";

/**
 * Recovery affordance for an OAuth waiting state: the proxy already tried to
 * open the browser server-side, so this block only matters once that failed.
 * It exposes the authorization URL as selectable text, copies it, and offers a
 * manual open — the single owner for all three login surfaces (workspace panel,
 * add-provider modal, Codex account modal).
 */
export function LoginUrlBlock({ url }: { url: string }) {
  const t = useT();
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // A new URL invalidates the old feedback. Without this the block would claim
  // "copied" over a URL the clipboard never received — the workspace panel is
  // remounted by its provider key, but the add-provider modal is not.
  useEffect(() => {
    clearTimer();
    setCopyState("idle");
  }, [url, clearTimer]);

  if (!url) return null;

  const copy = () => {
    void copyTextToClipboard(url).then((ok) => {
      clearTimer();
      setCopyState(ok ? "copied" : "unavailable");
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopyState("idle");
      }, FEEDBACK_MS);
    });
  };

  const label = copyState === "copied"
    ? t("prov.linkCopied")
    : copyState === "unavailable"
      ? t("prov.linkCopyUnavailable")
      : t("prov.copyLink");

  return (
    <div className="pwi-auth-url-wrap">
      <code className="pwi-auth-url">{url}</code>
      <div className="pwi-auth-url-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
          <IconLink style={{ width: 13, height: 13 }} aria-hidden="true" />
          <span aria-live="polite">{label}</span>
        </button>
        <a href={url} target="_blank" rel="noreferrer" className="pwi-auth-open-link">
          <IconExternal style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.didntOpen")}
        </a>
      </div>
    </div>
  );
}
