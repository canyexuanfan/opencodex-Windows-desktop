# 035 — WP3b: system-env / launchctl marker lifecycle (audit §4 + R2-4)

Split out of WP2 after round 2 judged that phase too broad. Depends on WP2's resolver.

## Why this phase exists

`ocx claude` is not the only path that produces the proxy marker. The macOS
auto-connect shell-env file and the launchctl env also inject it
(`src/server/system-env.ts:30-35`, `:238-255`), and both key on a stored `"proxy"`.
An auto+absent user therefore gets **nothing** when they type plain `claude` — the
feature would appear broken for exactly the population it exists to serve.

## MODIFY — `src/server/system-env.ts`

Both writers consult the resolver instead of the raw config value:

```diff
-  } else if (config.claudeCode?.authMode === "proxy") {
+  } else if (resolveClaudeAuthMode(config, detectClaudeAuth(defaultAuthDetectDeps())).markerMode === "proxy") {
```

and symmetrically, a `subscription` resolution must REMOVE a previously written
marker line / launchctl variable — the existing code already has that shape for the
`authMode !== "proxy"` branch (`:241-255` unsets when the launchctl value is ours), so
this is a predicate swap, not new machinery. The exported `PROXY_MARKER` constant
(WP1) replaces the inline string so the "is this ours?" test cannot drift.

## The honest promise (R2-4)

The shell file is a **snapshot**, not a live view. It changes only when
`injectSystemEnv` runs: proxy start (`src/cli/index.ts:269-273`), `ocx ensure`
(`:315-321`), or a settings save (`agent-settings-routes.ts:816-818` already calls
`applySystemEnvToggle` when `authMode`/`systemEnv` change). So a user who logs into
Claude AFTER an auto-absent write keeps the marker until one of those runs.

This unit does not add a credential watcher — that is a separate feature with its own
cost. Instead the promise is narrowed and made visible:

- `ocx claude` resolves LIVE on every launch (authoritative path, already correct);
- the docs and the GUI state that the shell snapshot refreshes on restart / `ocx
  ensure` / a settings save;
- the GUI's existing save already triggers the refresh, so "it did not update" has a
  one-click answer instead of a mystery.

## GUI manual-env snippet

`gui/src/pages/claude-manual-env.ts:36-45` is generated from the GET payload's
`markerMode`, so the copy-paste block and the real launch cannot disagree.

## TESTS — `tests/claude-system-env-auto.test.ts` (NEW)

- auto + absent → the writer emits the marker line;
- auto + present → it does NOT, and a previously written marker line is removed;
- auto + unknown → subscription behaviour (no marker), matching the resolver;
- manual proxy → marker regardless of detection; manual subscription → none;
- launchctl path follows the same four cases;
- the "is this ours?" check uses `PROXY_MARKER`, so a user-set token is never unset.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/claude-system-env-auto.test.ts tests/system-env*.test.ts` | pass |
| `cd gui && bun test tests/claude-manual-env*.test.*` | pass |
