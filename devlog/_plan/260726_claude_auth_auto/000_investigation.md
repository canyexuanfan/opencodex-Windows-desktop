# 000 — 260726 claude-auth-auto: investigation

## Objective (user's brief, restated)

1. Claude auth가 있는지 보고, 없으면 자동으로 프록시 모드로 실행되게.
2. Claude auth가 등록되면 자동으로 변환되게.
3. 수동 변환(명시적 proxy/subscription)은 그 설정이 계속되도록.
4. "작동 안 된다"는 리포트가 많아서 하드닝 루프까지.

Baseline: `dev` at `911373db` (pushed, CI green).

## Current authMode flow, with the source located

`OcxClaudeCodeConfig.authMode?: "proxy"` (`src/types.ts:366-369`) — absent means
"subscription", the default. There is no third state today.

`buildClaudeEnv` (`src/cli/claude.ts:24-113`) assembles the launch env:

- never sets `ANTHROPIC_API_KEY` (both token vars trigger Claude Code's auth-conflict
  warning);
- when `config.apiKeys` is non-empty it injects `ANTHROPIC_AUTH_TOKEN = apiKeys[0].key`
  (the proxy admission key) — `:53-55`;
- when no AUTH_TOKEN ended up set and `authMode === "proxy"`, it injects
  `ANTHROPIC_AUTH_TOKEN = "opencodex-proxy"` — `:56-58`. This is the proxy-mode marker:
  the proxy accepts it and serves routed models;
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1"` is injected ONLY when an AUTH_TOKEN is
  present (`:79-81`) — the #253 fix: the flag without a host token makes a valid
  subscription look logged out. Regression coverage exists in
  `tests/claude-cli.test.ts` ("subscription mode leaves the host auth assertion
  unset", "a user pre-export of the flag wins").

The management API round-trips the mode: GET `/api/claude-code` returns
`authMode: "proxy" | "subscription"` (`agent-settings-routes.ts:615-617`), and the PUT
persists it — `"proxy"` stores the key, `"subscription"` deletes it
(`agent-settings-routes.ts:693-703`), the round-trip fixed in
`devlog/_fin/260720_claude_authmode_persist`. The GUI select is
`gui/src/pages/claude-code-sections.tsx:38-48` with exactly those two options.

On the wire, `src/server/claude-messages.ts` distinguishes native passthrough (a
client forwarding its own Claude OAuth — the subscription case) from routed traffic,
and marks `logCtx.surface` (`:514`, `:552-555`).

## Detection surfaces (verified live on this machine, 2026-07-26)

| # | Source | Shape | Verified |
|---|--------|-------|----------|
| S1 | `~/.claude.json` → `oauthAccount` | JSON, cross-platform | present here: `billingType: "stripe_subscription"` |
| S2 | `~/.claude/.credentials.json` | JSON token file (Linux/Windows) | absent here |
| S3 | macOS Keychain `Claude Code-credentials` | `security find-generic-password` exit 0 | present here |
| S4 | ocx's own anthropic OAuth account | `src/oauth` credential store | code exists (`src/oauth/anthropic.ts`) |
| S5 | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` env | user-exported | — |

S1 is the cheapest cross-platform read. S3 requires spawning `security`, which can
fail or be denied — a failure there must be `unknown`, never `absent`. S5 doubles as
both a detection source and a launch-env input.

## The design that follows (locked after the failure-mode inventory in 001)

**Auto is a resolution, not a stored value.** `authMode` unset keeps meaning "auto"
(the new default): every launch and every status read recomputes it from the detector.
That is what makes "auth가 등록되면 자동으로 변환" free — there is no stored state to
migrate; the next resolution simply sees the credential.

- auto + auth present → subscription behaviour (no token injection; native
  passthrough for claude models).
- auto + auth absent → proxy behaviour (`ANTHROPIC_AUTH_TOKEN = "opencodex-proxy"`).
- auto + detection unknown → subscription behaviour + a visible warning. **This is
  the safety rule**: flipping a subscriber into proxy mode because a keychain prompt
  was denied is the worst outcome this feature can produce, so unknown degrades to
  the historical default, never to the new one.

**Manual always wins.** An explicit `"proxy"` or `"subscription"` (the two values the
config already stores) bypasses the detector entirely, forever. The auto logic never
writes `authMode` — it only reads it. Manual persistence is already proven by the
260720 round-trip; this feature must not regress it.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP0 | `000` + `001` | Investigation + failure-mode inventory | — |
| WP1 | `010_auth_detector.md` | 3-value detector, per-source + aggregate | — |
| WP2 | `020_auto_resolution.md` | Shared resolver; CLI env + GET effectiveMode; sticky-manual tests | WP1 |
| WP3 | `030_gui_effective_mode.md` | Claude tab effective-mode badge + reason, locales | WP2 |
| WP4 | `040_hardening.md` | config-overwrite protection, hijack verification, review, gates, live smoke | WP2 |

## Accept criteria

Mirrored into the goalplan: c-docs, c-detect, c-auto, c-sticky, c-253, c-gui, c-i18n,
c-hardening, c-gates, c-smoke.
