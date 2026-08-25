import { useState } from "react";
import { useT } from "../i18n/shared";
import { useKeyedClientResource } from "../client-resource";
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
  // A local preference wins outright; otherwise the box mirrors the persisted
  // setting, so the checkbox and the config file never disagree on screen.
  const localPref = readOpenBrowserPref();
  const [choice, setChoice] = useState<boolean | undefined>(localPref);

  // The server default is a fetched RESOURCE, not component state, so it does
  // not need a post-await setState — which is both the react-doctor rule and
  // the honest model: this component owns the operator's choice, not the
  // server's setting.
  const serverPref = useKeyedClientResource(
    `oauth-open-browser:${apiBase ?? ""}`,
    [apiBase],
    async (signal) => {
      if (!apiBase) return true;
      const res = await fetch(`${apiBase}/api/settings`, { signal });
      if (!res.ok) return true;
      const data = await res.json() as { oauthOpenBrowser?: boolean };
      return typeof data.oauthOpenBrowser === "boolean" ? data.oauthOpenBrowser : true;
    },
  );

  // Until this operator chooses, follow the server; a failed read leaves the
  // historical auto-open on screen.
  const open = choice ?? serverPref.data ?? true;

  return (
    <label className="open-browser-pref">
      <input
        type="checkbox"
        checked={!open}
        onChange={e => {
          const next = !e.target.checked;
          setChoice(next);
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
