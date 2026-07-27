import { useCallback, useEffect, useRef, useState } from "react";
import { IconExternal, IconLink } from "../icons";
import { useT } from "../i18n/shared";
import { copyTextToClipboard } from "../oauth-health-display";

const FEEDBACK_MS = 2500;

type CopyOutcome = "copied" | "unavailable";

/**
 * Recovery affordance for an OAuth waiting state: the proxy already tried to
 * open the browser server-side, so this block only matters once that failed.
 * It exposes the authorization URL as selectable text, copies it, and offers a
 * manual open — the single owner for all three login surfaces (workspace panel,
 * add-provider modal, Codex account modal).
 */
export function LoginUrlBlock({ url }: { url: string }) {
  const t = useT();
  // Feedback carries the URL it belongs to. A new URL therefore reads as idle
  // without an effect: the add-provider modal keeps this block mounted across a
  // provider switch, and stale "copied" would claim a URL the clipboard never got.
  const [feedback, setFeedback] = useState<{ url: string; outcome: CopyOutcome } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  if (!url) return null;

  const outcome = feedback?.url === url ? feedback.outcome : null;

  const copy = () => {
    void copyTextToClipboard(url).then((ok) => {
      clearTimer();
      setFeedback({ url, outcome: ok ? "copied" : "unavailable" });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setFeedback(null);
      }, FEEDBACK_MS);
    });
  };

  const label = outcome === "copied"
    ? t("prov.linkCopied")
    : outcome === "unavailable"
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
