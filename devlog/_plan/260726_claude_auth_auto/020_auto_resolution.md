# 020 — WP2: auto resolution — CLI env, effective-mode endpoint, sticky manual

Depends on WP1. Contract from `000`/`001`; audit fold-backs from `002` (blockers 1,
2, 3) — the feedback loop, the admission-key axis, and three-state intent.

## What the resolver answers (exactly one question)

**Does the proxy-mode dummy marker (`ANTHROPIC_AUTH_TOKEN=opencodex-proxy`) get
injected?** That is the whole of `effectiveAuthMode`.

The admission-key axis is SEPARATE and unchanged: when `config.apiKeys` is non-empty,
`buildClaudeEnv` injects `config.apiKeys[0].key` as `ANTHROPIC_AUTH_TOKEN` regardless
of mode (pre-existing behaviour, `cli/claude.ts:55-57`, documented at `:50-54`). The
GET payload exposes both axes (`admissionKeyActive`) so the GUI never presents
"subscription" as "no token anywhere".

## NEW — `src/claude/auth-mode.ts`

One resolver shared by the CLI and the management API, so launch-time and the GUI can
never disagree:

```ts
import type { OcxConfig } from "../types";
import { detectClaudeAuth, type AuthDetectResult, type AuthSourceId } from "./auth-detect";

export type EffectiveAuthMode = "proxy" | "subscription";

export interface ResolvedAuthMode {
  effective: EffectiveAuthMode;
  /** Why: manual override, or which auto path resolved. */
  origin: "manual" | "auto-present" | "auto-absent" | "auto-unknown";
  /** The detector source that proved presence (origin auto-present only). */
  foundBy?: AuthSourceId;
  detection: AuthDetectResult;
}

/**
 * The ONLY writer of the effective mode. Manual authMode is read, never written here:
 * an explicit "proxy"/"subscription" bypasses the detector forever (c-sticky), and the
 * auto logic cannot "helpfully" rewrite it when auth appears or disappears.
 *
 * auto-unknown resolves to subscription: the historical default, because flipping a
 * subscriber into proxy mode on a failed read is the F1 failure.
 */
export function resolveClaudeAuthMode(config: OcxConfig, detection: AuthDetectResult): ResolvedAuthMode {
  if (config.claudeCode?.authMode === "proxy") {
    return { effective: "proxy", origin: "manual", detection };
  }
  if (config.claudeCode?.authMode === "subscription") {
    // Literal "subscription" (002 §3): an explicit choice must survive auth flips too.
    return { effective: "subscription", origin: "manual", detection };
  }
  switch (detection.presence) {
    case "present": return { effective: "subscription", origin: "auto-present", foundBy: detection.foundBy, detection };
    case "absent": return { effective: "proxy", origin: "auto-absent", detection };
    case "unknown": return { effective: "subscription", origin: "auto-unknown", detection };
  }
}
```

### Config shape — three-state intent, literal strings

The audit's simpler alternative wins over the boolean: `authMode?: "proxy" |
"subscription"` — unset = auto. Literal `"subscription"` is self-describing and
backward-safe: old readers map any non-"proxy" value to "subscription" anyway
(`agent-settings-routes.ts:615-617`), so an old proxy reading a new config keeps the
user's explicit choice instead of silently dropping it. Widen the type in
`src/types.ts` and add the enum to `configSchema` in `src/config.ts`.

## MODIFY — `src/cli/claude.ts` (`buildClaudeEnv`)

Replace the `authMode === "proxy"` check with the resolver:

```diff
-  if (!env.ANTHROPIC_AUTH_TOKEN && config.claudeCode?.authMode === "proxy") {
-    env.ANTHROPIC_AUTH_TOKEN = "opencodex-proxy";
-  }
+  const resolved = resolveClaudeAuthMode(config, detectClaudeAuth(deps.authDetectDeps ?? defaultAuthDetectDeps()));
+  // Feedback-loop guard (002 §1): OUR stale marker is not auth. On a subscription
+  // resolution it must not ride the spawn env, or the launch stays de-facto proxy
+  // while the badge and the CLI both report subscription.
+  if (resolved.effective === "subscription" && env.ANTHROPIC_AUTH_TOKEN === PROXY_MARKER) {
+    delete env.ANTHROPIC_AUTH_TOKEN;
+  }
+  if (!env.ANTHROPIC_AUTH_TOKEN && resolved.effective === "proxy") {
+    env.ANTHROPIC_AUTH_TOKEN = "opencodex-proxy";
+  }
+  if (resolved.origin === "auto-unknown") {
+    console.error("⚠ Claude auth could not be verified; keeping subscription behaviour. Set authMode explicitly in the GUI to override.");
+  }
```

Ordering matters: the marker deletion runs BEFORE the injection check, so a stale
marker cannot satisfy `!env.ANTHROPIC_AUTH_TOKEN` and keep the launch in de-facto
proxy mode.

`buildClaudeEnv` gains an optional trailing `deps` parameter (defaults to real IO) so
tests inject the detector without touching the real home — same pattern as
`contextWindows`. Detection reads the SAME base env the launch will use (`base`, not
`process.env`), so the two can never disagree (002 §1).

The F4 invariant is untouched: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` still ships
only when an AUTH_TOKEN exists. Under auto→subscription with no admission key that
is now genuinely never — previously a stale marker could have satisfied it. With an
admission key configured the flag DOES ship, which is correct: opencodex really does
own authentication on that deployment (002 §2).

## MODIFY — GET `/api/claude-code` (`agent-settings-routes.ts:605-640`)

`authMode` stops coercing absent → `"subscription"`: absent now means auto, and the
coercion is exactly what silently killed auto on every save (002 §3).

```ts
const detection = detectClaudeAuth(defaultAuthDetectDeps());
const resolved = resolveClaudeAuthMode(config, detection);
// ...
authMode: config.claudeCode?.authMode ?? "auto",
effectiveAuthMode: resolved.effective,
authModeOrigin: resolved.origin,
...(resolved.foundBy ? { authFoundBy: resolved.foundBy } : {}),
authDetectionUnknown: detection.presence === "unknown",
// The SEPARATE admission axis (002 §2): with an admission key configured a token is
// injected regardless of mode, so the GUI must never present subscription as
// "no token anywhere".
admissionKeyActive: (config.apiKeys?.length ?? 0) > 0,
```

PUT accepts all three intents: `"proxy"` stores `"proxy"`, `"subscription"` stores
the literal `"subscription"`, and `"auto"` DELETES the key — the return-to-auto path
the current two-option select cannot express. Validation widens to
`"auto" | "proxy" | "subscription"`; anything else still 400s.

## MODIFY — `src/server/system-env.ts` + launchctl (002 §4)

Today the shell-env file and the launchctl env inject the marker only for a stored
`"proxy"` (`system-env.ts:32-35`, `:241-255`), so an auto+absent user gets nothing on
an ordinary `claude` launch — the "작동 안 된다" report in its purest form. Both
writers move behind the same resolution:

- compute `resolveClaudeAuthMode(config, detectClaudeAuth(defaultAuthDetectDeps()))`
  at (re)write time;
- resolution proxy (manual OR auto-absent) → write the marker line;
- resolution subscription → do NOT write it, and REMOVE a previously written marker
  line so the file cannot strand the user in proxy mode;
- the GUI manual-env snippet (`gui/src/pages/claude-manual-env.ts:36-45`) is built
  from the GET payload's `effectiveAuthMode`, so the copy-paste block and the real
  launch can never disagree.

## TESTS

`tests/claude-auth-mode.test.ts` (NEW):

- auto + present → subscription; auto + absent → proxy; auto + unknown → subscription
  with origin auto-unknown;
- **c-sticky**: manual proxy survives presence flips (present→absent→present) — same
  result every time; manual explicit subscription likewise;
- **the feedback loop (002 §1)**: base env carrying
  `ANTHROPIC_AUTH_TOKEN=opencodex-proxy` with auth now PRESENT → the marker is
  deleted, the mode resolves subscription, and no host flag ships;
- **admission axis (002 §2)**: detected credential + `config.apiKeys` → effective
  subscription AND the admission token still injected AND the host flag present;
- **c-253**: `buildClaudeEnv` under auto→subscription emits NO
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; under auto→absent it emits the proxy token
  AND the flag;
- **F5**: env carrying `ANTHROPIC_API_KEY` resolves present, and
  `ANTHROPIC_AUTH_TOKEN` stays unset;
- GET returns `authMode: "auto"` for an unset key (NO coercion) plus
  `effectiveAuthMode` / `authModeOrigin` / `admissionKeyActive`;
- PUT `"subscription"` stores the literal, `"auto"` deletes the key, `"proxy"`
  unchanged, invalid values still 400 — the 260720 round-trip contract survives as a
  superset;
- **the auto-kill regression (002 §3)**: GET(auto) → PUT that changes only an
  unrelated field → the stored intent is still auto;
- system-env: auto-absent writes the marker; auto-present does not AND removes a
  stale marker line; launchctl path follows the same rule.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-auth-mode.test.ts tests/claude-auth-detect.test.ts tests/claude-cli.test.ts` | pass |
| `bun x tsc --noEmit` | clean |
