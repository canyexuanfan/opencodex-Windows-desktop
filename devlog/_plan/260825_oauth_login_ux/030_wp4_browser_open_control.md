# 030 — WP4: the operator decides whether the proxy opens a browser

**Issue:** feature proposal. **PR base:** `dev`. **Screenshot:** required if the GUI toggle lands.

## The defect

`oauth-account-routes.ts:170-175`:

```ts
if (authUrl && !deviceCode) {
  const { openUrl } = await import("../../lib/open-url");
  openUrl(authUrl);
}
```

`open-url.ts:11-24` spawns `open` / `xdg-open` / `rundll32`, which resolves
the **OS default browser** and therefore the default profile. Two consequences
the operator reported:

1. **Wrong profile.** The login lands in whichever Chrome profile is default.
   An operator who wants a second account, or a work identity, cannot get
   there — and because the URL is not copyable during a first add (WP3), there
   is no way around it either.
2. **Wrong machine.** With the GUI open over SSH or a tunnel, the browser
   opens on the *proxy host*, which is not where the human is. `open-url.ts`
   swallows spawn errors deliberately, so nothing reports that this happened.

## The change

### 1. Config — `src/types/config.ts`

```ts
/** Whether a login may open a browser on the machine running the proxy. */
oauthOpenBrowser?: boolean;
```

A boolean, not an enum. `undefined` and `true` both mean "open" — that is
the existing behavior, and it stays the behavior for every operator who does
nothing. `false` means "never open; give me the link."

An `"auto"` mode that sniffs `SSH_CONNECTION` or a missing `DISPLAY` is
deliberately **not** in this phase (`002`). Inference that is wrong breaks a
working login silently; that needs its own evidence and its own issue.

### 2. Per-request override — `POST /api/oauth/login`

```diff
-const body = … as { provider?: string; addAccount?: boolean; accountId?: string; reauth?: boolean };
+const body = … as { provider?: string; addAccount?: boolean; accountId?: string; reauth?: boolean; openBrowser?: boolean };
```

Resolution, in one helper so both login routes share it:

```ts
// Request beats config; config beats the historical default.
function shouldOpenBrowserForLogin(requested: unknown, config: OcxConfig): boolean {
  if (typeof requested === "boolean") return requested;
  return config.oauthOpenBrowser !== false;
}
```

A non-boolean `openBrowser` is ignored rather than rejected: this is a UX
preference, and a malformed one must not fail a login.

Same treatment for the Codex path at `src/codex/auth-api.ts:1844`.

### 3. GUI

Two surfaces, both small:

- **A checkbox in the login-hint component (WP2).** "Don't open a browser on
  the proxy host" — checked state is remembered in `localStorage` and sent as
  `openBrowser: false` on the next login start. This is the affordance the
  operator actually asked for: start the login, copy the link, open it wherever
  they want.
- **A persisted toggle** in the providers settings area writing
  `oauthOpenBrowser` through the existing config route, for an operator who
  never wants the proxy touching a browser.

### 4. Deliberately not changing `open-url.ts`

Honoring a `BROWSER` environment variable or a configured argv is a real
pattern and a real request ("크롬 다른 프로필"). It is also the part of this
change that can execute an operator-supplied command, and it belongs in a PR
that can be reviewed as a command-execution change rather than as a UX change.

If it lands later, the shape is fixed now: **argv array only**, never a shell
string, `shell: false` preserved, empty means skip. Recorded here so the next
cycle does not relitigate it.

## Security

- Device flows still never auto-open (`!deviceCode` guard preserved).
- No provider-supplied URL becomes newly openable. This phase only ever makes
  `openUrl` fire *less*.
- `openUrl`'s `^https?://` guard at `open-url.ts:12` is untouched.
- The management route already requires the session/admin gate; the new field
  changes nothing about admission.

## Test

`tests/oauth-open-browser-choice.test.ts` (new), against
`shouldOpenBrowserForLogin` and the route:

| `openBrowser` in body | `oauthOpenBrowser` in config | opens? |
|---|---|---|
| absent | absent | **yes** — the compatibility case |
| absent | `true` | yes |
| absent | `false` | no |
| `false` | absent | no |
| `false` | `true` | no |
| `true` | `false` | yes |
| `"nope"` | absent | yes — malformed is ignored |

Row 1 is the one that matters: it is the regression test for "we did not
silently change what already worked."

The route test injects a spy opener rather than spawning a real browser.

## Acceptance

- Default install: identical behavior, proven by row 1.
- With the box checked, no browser is spawned and the link is on screen to
  copy into any profile or any machine.
- `bun run typecheck`, `bun run test`, `bun run privacy:scan` green.
