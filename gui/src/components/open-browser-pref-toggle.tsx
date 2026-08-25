import { useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { readOpenBrowserPref, writeOpenBrowserPref } from "../oauth-open-browser-pref";

/**
 * The operator's answer to "should the proxy open a browser for me?"
 *
 * It sits next to the button that STARTS a login, not inside the waiting state,
 * because the request carries the choice — a toggle shown after the browser has
 * already been launched would be advice for next time rather than a control.
 *
 * Unchecking it is what makes a different Chrome profile reachable: the login
 * still starts, the authorization URL is still returned and displayed, and
 * nothing is spawned on the proxy's machine, so the operator opens the link
 * wherever they actually want to be signed in.
 */
export function OpenBrowserPrefToggle({ apiBase }: { apiBase?: string }) {
  const t = useT();
  // No local preference means "follow the server", so the box starts by
  // reflecting the persisted setting rather than asserting a default of its own.
  const [open, setOpen] = useState(() => readOpenBrowserPref() ?? true);
  const [seeded, setSeeded] = useState(() => readOpenBrowserPref() !== undefined);

  useEffect(() => {
    if (seeded || !apiBase) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/settings`);
        if (!res.ok) return;
        const data = await res.json() as { oauthOpenBrowser?: boolean };
        if (!alive || typeof data.oauthOpenBrowser !== "boolean") return;
        // Still no local preference: mirror the server rather than override it.
        if (readOpenBrowserPref() === undefined) setOpen(data.oauthOpenBrowser);
      } catch {
        // A failed read leaves the historical default on screen.
      } finally {
        if (alive) setSeeded(true);
      }
    })();
    return () => { alive = false; };
  }, [apiBase, seeded]);

  return (
    <label className="open-browser-pref">
      <input
        type="checkbox"
        checked={!open}
        onChange={e => {
          const next = !e.target.checked;
          setOpen(next);
          writeOpenBrowserPref(next);
        }}
      />
      <span className="open-browser-pref-copy">
        <span className="text-label">{t("prov.dontOpenBrowser")}</span>
        <span className="muted text-label">{t("prov.dontOpenBrowserHint")}</span>
      </span>
    </label>
  );
}
