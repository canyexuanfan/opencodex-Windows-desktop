# 001 — failure-mode inventory ("작동 안 된다" 리포트 클래스)

Each entry: the failure, the evidence, and which work-phase owns the fix or the proof
that it is already handled.

## F1 — detection false-absent flips a subscriber into proxy mode

A keychain prompt denied, a sandboxed `security` call, a partially-written
`~/.claude.json`, or a permission error on `.credentials.json` all look like "no
auth" to a naive detector. Flipping that user into proxy mode changes which models
they get and can surface as "Claude stopped working" — the exact report class this
project is trying to kill. **Design answer:** three-value detection; `unknown`
resolves to subscription (the historical default) with a warning. Owned by WP1/WP2,
criterion c-detect + c-auto.

## F2 — running service silently overwrites hand-edited config.json (#488 item 1)

The service holds config in memory and every `saveConfig` writes the whole object.
A user who hand-edits `~/.opencodex/config.json` while the service runs loses the
edit at the next save — the report says it surfaces at stop/restart. For THIS unit
the dangerous subtree is `claudeCode` (authMode and friends): a user who sets
`authMode` by hand must not lose it. **Design answer:** a scoped
persist-preserving-user-edits for the `claudeCode` subtree: `loadConfig` snapshots
the subtree at load; a guarded save reloads the file and, when the on-disk subtree
differs from the snapshot (external edit) and the in-memory subtree equals the
snapshot (we did not change it), the disk version wins. Owned by WP4, criterion
c-hardening.

## F3 — stale `~/.claude/settings.json` env hijack (cc-switch/CCR leftovers)

A leftover `env` block in `~/.claude/settings.json` (ANTHROPIC_BASE_URL pointing at
another proxy, model slots) can silently hijack routing away from opencodex. The
existing defence is `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` (`cli/claude.ts:74-82`),
which makes Claude Code strip provider-managed vars from settings — but it is only
injected when a host token exists, because the flag without one is the F4 failure.
So in subscription mode the hijack is possible. **Design answer:** verify the defence
coverage honestly in WP4 and document the residual; do NOT "fix" it by injecting the
flag without a token (that reintroduces F4).

## F4 — host-managed flag without a host token (#253, already fixed — keep it fixed)

`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` without a host token makes a valid
subscription look logged out. Guard exists (`cli/claude.ts:79-81` injects the flag
only when `ANTHROPIC_AUTH_TOKEN` is set) with regression tests in
`tests/claude-cli.test.ts`. The auto mode must preserve this invariant on every new
path: auto→subscription must never emit the flag. Owned by WP2, criterion c-253.

## F5 — auth-conflict warning from coexisting token vars

`buildClaudeEnv` never sets `ANTHROPIC_API_KEY`, but a user-exported API key plus an
injected `ANTHROPIC_AUTH_TOKEN` can still coexist and trigger Claude Code's
auth-conflict warning. The auto resolver treats a user-exported `ANTHROPIC_API_KEY`
as auth-present (S5) — which conveniently also means no proxy token is injected for
that user. Owned by WP2 (detector source S5) — verify with a test that an exported
API key keeps `ANTHROPIC_AUTH_TOKEN` unset in auto mode.

## F6 — stale gateway model cache / picker

Handled already: `refreshGatewayModelCacheFromProxy` before spawn
(`cli/claude.ts:190-199`). Listed so the inventory is complete; no new work.

## F7 — auto-connect (systemEnv) on unsupported platforms

`reconcileAutoConnectState` (`gui/src/pages/claude-autoconnect.ts`) already fails
closed when the backend omits the capability. No new work; referenced for the GUI
phase's conventions.

## What "manual conversion persists" means precisely

The user asked 수동 변환 시 설정이 계속되도록. Three layers, all must hold:

1. The config write itself round-trips (proven by 260720 — do not regress).
2. The auto logic never WRITES `authMode` — resolution is read-only, so a manual
   value is never "helpfully" updated when auth appears or disappears.
3. A hand-edit of config.json survives the running service (F2) — at least for the
   `claudeCode` subtree.
