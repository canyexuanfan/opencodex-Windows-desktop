# 020 — WP2: auto resolution — CLI env, effective-mode endpoint, sticky manual

Depends on WP1. Contract from `000`/`001` (F1, F4, F5, and the sticky-manual rule).

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
  if (config.claudeCode?.authModeExplicitSubscription === true) {
    // see "config shape" below — an explicit subscription must survive auth flips too
    return { effective: "subscription", origin: "manual", detection };
  }
  switch (detection.presence) {
    case "present": return { effective: "subscription", origin: "auto-present", foundBy: detection.foundBy, detection };
    case "absent": return { effective: "proxy", origin: "auto-absent", detection };
    case "unknown": return { effective: "subscription", origin: "auto-unknown", detection };
  }
}
```

### Config shape — the explicit-subscription gap

Today `authMode?: "proxy"` cannot distinguish "user chose subscription" from "never
chose anything" — both are `undefined`, and under auto they must behave differently
(the first is sticky, the second resolves). Add ONE optional boolean to
`OcxClaudeCodeConfig` (`src/types.ts`), `authModeExplicitSubscription?: boolean`, set
by the PUT route when the user picks subscription explicitly; `"proxy"` keeps its
existing storage. `configSchema` is `.passthrough()` but gets the field for contract
clarity.

## MODIFY — `src/cli/claude.ts` (`buildClaudeEnv`)

Replace the `authMode === "proxy"` check with the resolver:

```diff
-  if (!env.ANTHROPIC_AUTH_TOKEN && config.claudeCode?.authMode === "proxy") {
-    env.ANTHROPIC_AUTH_TOKEN = "opencodex-proxy";
-  }
+  const resolved = resolveClaudeAuthMode(config, detectClaudeAuth(deps.authDetectDeps ?? defaultAuthDetectDeps()));
+  if (!env.ANTHROPIC_AUTH_TOKEN && resolved.effective === "proxy") {
+    env.ANTHROPIC_AUTH_TOKEN = "opencodex-proxy";
+  }
+  if (resolved.origin === "auto-unknown") {
+    console.error("⚠ Claude auth could not be verified; keeping subscription behaviour. Set authMode explicitly in the GUI to override.");
+  }
```

`buildClaudeEnv` gains an optional trailing `deps` parameter (defaults to real IO) so
tests inject the detector without touching the real home — same pattern as
`contextWindows`. The F4 invariant is untouched: `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
still ships only when an AUTH_TOKEN exists, which under auto→subscription never
happens. F5 falls out: an exported `ANTHROPIC_API_KEY` makes detection present, so no
proxy token is injected.

## MODIFY — GET `/api/claude-code` (`agent-settings-routes.ts:605-640`)

Add to the payload (computed per request — auto is a resolution, not state):

```ts
const detection = detectClaudeAuth(defaultAuthDetectDeps());
const resolved = resolveClaudeAuthMode(config, detection);
// ...
effectiveAuthMode: resolved.effective,
authModeOrigin: resolved.origin,
...(resolved.foundBy ? { authFoundBy: resolved.foundBy } : {}),
authDetectionUnknown: detection.presence === "unknown",
```

PUT: when `authMode === "subscription"` also set
`next.authModeExplicitSubscription = true`; when `"proxy"` delete that flag too.

## TESTS

`tests/claude-auth-mode.test.ts` (NEW):

- auto + present → subscription; auto + absent → proxy; auto + unknown → subscription
  with origin auto-unknown;
- **c-sticky**: manual proxy survives presence flips (present→absent→present) — same
  result every time; manual explicit subscription likewise;
- **c-253**: `buildClaudeEnv` under auto→subscription emits NO
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`; under auto→absent it emits the proxy token
  AND the flag;
- **F5**: env carrying `ANTHROPIC_API_KEY` resolves present, and
  `ANTHROPIC_AUTH_TOKEN` stays unset;
- GET returns `effectiveAuthMode`/`authModeOrigin` consistent with the resolver
  (extend `tests/claude-management-api.test.ts` style harness);
- PUT subscription sets the explicit flag; PUT proxy clears it; GET authMode output
  unchanged from the 260720 contract.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-auth-mode.test.ts tests/claude-auth-detect.test.ts tests/claude-cli.test.ts` | pass |
| `bun x tsc --noEmit` | clean |
