# 030a — WP5 investigation: four display/routing defects, root-caused

Docs-only investigation pass (LOOP-DOCS-FIRST-01 discovered-scope rule): the user
reported four symptoms mid-loop. This document records each root cause against the
current tree and scopes the fix. No code changes in this work-phase.

Baseline: `dev` at `ff3429ff`. Every claim below carries a live `path:line` citation.

## D1 — context windows render as `1.048576M` and there is no 1M affordance

**Symptom.** On the Claude Desktop page, models with a 1 MiB context window show
`1.048576M`, and the user says there is no 1M setting — Claude appears capped at 200k.

**Root cause — two independent facts.**

1. *Formatting.* `gui/src/pages/ClaudeDesktop.tsx:104-110` `formatContextWindow` divides
   by `1_000_000` and interpolates into `claudeDesktop.contextM` = `"{n}M context"`.
   Several providers genuinely report `1_048_576` (2^20): `google-antigravity/gemini-3.1-pro`,
   `gemini-3.6-flash`, and `kimi/k3[1m]` all come back from the live API as `1048576`
   (verified via `curl :10100/api/claude-desktop`). `1048576 / 1e6 = 1.048576`, so the
   string is literally correct math but reads as a bug. Fix: format windows `>= 1_048_576`
   (i.e. anything at or above 1 MiB) as a rounded `1M`, or divide by `1_048_576` when the
   value is a multiple of it. This is display-only and identical in `Grok.tsx:21-26`.

2. *Native models have NO context window at all.* The bigger real defect:
   `buildClaudeDesktopState` (`src/server/management/shared.ts:193-200`) maps routed
   models to `{ route, label, ...(contextWindow) }` but native models to
   `{ route: \`native/${id}\`, label }` with **no contextWindow**. So every `native/gpt-5.x`
   row returns `ctx=None` (verified live) and renders nothing. The value already exists:
   `nativeOpenAiContextWindow(slug)` (`src/codex/catalog/metadata.ts:68`) — the same
   accessor the Grok sync already uses (`src/grok/sync.ts:38-43`) after WP3's fix
   (`81a6a956`). `shared.ts:194` simply never calls it. So Sol's 372k and gpt-5.5's
   272k are invisible on Desktop even though they are known everywhere else.

**The 1M setting the user asked about.** It IS implemented, but only in the writer, not
the dashboard. `src/claude/desktop-3p.ts` sets `supports1m`/`prefer1m` on a Desktop
registry entry whenever the routed `contextWindow >= SUPPORTS_1M_THRESHOLD = 1_000_000`
(`desktop-3p.ts:42`, `:166-168`, `:178`, `:196-197`). So `alibaba-token-plan-intl/glm-5.2`
(exactly 1M) and the 1 MiB models DO get `prefer1m` in the written config. The gap is
that **the dashboard never shows it**: `buildClaudeDesktopState` does not surface
`supports1m`/`prefer1m` on `DesktopModel`, so there is no 1M chip and no way to see or
pin it. The user read "no 1M chip" as "no 1M support" — a fair read of a missing
surface.

**Fix scope.** (a) format `>=1 MiB` as `1M`; (b) pass `nativeOpenAiContextWindow` into
the native rows in `buildClaudeDesktopState`; (c) add `supports1m` to the Desktop DTO
and a compact `1M` chip on the collapsed row summary, plus a `prefer1m` toggle in the
expanded body for eligible rows. No change to the writer's threshold logic.

## D2 — no "claude-api 방어로직" (Anthropic-API input guard) on Desktop

**Symptom.** The user expects the Claude API surface to have a defensive input layer
(like the one guarding image payloads), and reports it absent.

**What exists.** There IS an Anthropic image guard:
`src/adapters/anthropic-image-guard.ts` (`enforceAnthropicImageLimits`) and
`anthropic-image-normalize.ts`, invoked from `src/server/claude-messages.ts`. So the
pattern is established.

**What is missing.** The guard applies to the *Claude Code / native passthrough* path,
not specifically to the **Desktop 3P** config surface. `desktop-3p.ts` writes the
registry but performs no validation of the generated model entries beyond alias
collision checks (`:180-186`) and the alias-decode registry. There is no guard that the
emitted `inferenceModels` stay within Anthropic's documented schema (e.g. that
`supports1m` is only emitted for genuinely ≥1M models, that `labelOverride` stays
within length limits, or that a routed model id containing `[1m]` markers is handled
deliberately rather than passing the marker through into a name Desktop will misread).
`kimi/k3[1m]` is the live case: its route literally contains `[1m]`, and
`desktop3pAlias`/`labelOverride` must not leak that bracket into a Desktop model name.

**Fix scope.** Add a validation pass over the emitted `Desktop3pModelEntry[]` inside
`desktop-3p.ts` (or a sibling `desktop-3p-guard.ts`) asserting the schema invariants
above, with a focused test. This is a write-path guard, mirroring how
`anthropic-image-guard.ts` guards the request path.

## D3 — no `claude` tag / `grok` tag on the usage page

**Symptom.** The usage filter only offers `all / codex / claude`, and the user wants
per-surface tags including a Grok tag.

**Root cause — three layers.**

1. *Filter is a fixed 3-way.* `gui/src/pages/Usage.tsx:210` maps a hardcoded
   `["all","codex","claude"]` onto `UsageSurface`, which is itself
   `"all"|"codex"|"claude"` (`src/usage/summary.ts:8`). There is no surface for Grok.

2. *The surface taxonomy is binary.* `summarizeUsage` (`src/usage/summary.ts:494-495`)
   classifies every entry as `claude` (`entry.surface === "claude" || "claude-desktop"`)
   or `codex` (`entry.surface !== "claude"`). `PersistedUsageEntry.surface` is typed
   `"claude" | "claude-desktop"` (`src/usage/log.ts:39`), so any entry without a
   surface — which is every Codex and every Grok request today — is silently bucketed
   as `codex`.

3. *Grok requests are indistinguishable from Codex.* Grok Build calls the proxy on
   `/v1/chat/completions`. `handleChatCompletions` (`src/server/chat-completions.ts:47`)
   never sets `logCtx.surface`; it only exists in the type as `"claude"|"claude-desktop"`
   (`src/server/request-log.ts`, same two-value union as the usage log). So a Grok turn
   produces a usage entry with `surface: undefined`, and D3-2 buckets it as `codex`.
   The dashboard cannot show a Grok tag because the data was never labelled.

**Fix scope.** (a) widen `PersistedUsageEntry.surface` and the `UsageSurface` union to
include `"grok"` and `"codex"` explicitly (rather than "not claude"); (b) set
`logCtx.surface = "grok"` in `handleChatCompletions` when the request came through the
Grok managed fence — detectable because those requests hit `/v1/chat/completions` with
the `api_key = "opencodex-loopback"` the fence writes (`src/grok/inject.ts:148`), or a
dedicated header; (c) add `grok` to the Usage filter and its icon. The Codex bucket then
means "Codex CLI/App" instead of "everything that is not Claude".

## D4 — context shows `200k` for models that are larger

**Symptom.** Claude Desktop shows `200k` where a model is bigger.

**Root cause.** This is D1-2 with a different victim. Models whose provider omits a
context window render nothing (not `200k`) — but a model the catalog pins at 200k
shows `200k` even when the user expects more. Two sub-cases observed live:
`anthropic/claude-opus-4-6` returns `ctx=None` (provider gave no window, so it renders
blank), and the native models all return `ctx=None`. The literal `200_000` appears only
as `AUTO_CONTEXT_FLOOR` (`src/claude/context-windows.ts:19`) and in the test fixture —
no real row is *set* to 200k. So the user's "200k로 표시돼" is the rendering of an
unknown/blank window, not a wrong value: the fix is the same as D1-2 (give native rows
their real window) plus a deliberate display for "context unknown" instead of a blank.

## What each fix is and is not

| Defect | Is | Is not |
|--------|----|--------|
| D1a | A rounding/format fix in two `formatContext*` helpers | A data problem — the catalog values are correct |
| D1b | Pass an existing accessor into one map | A new metadata source — `nativeOpenAiContextWindow` already exists |
| D1c | Surface existing writer flags as UI | A change to the 1M threshold logic |
| D2 | A write-path schema guard for Desktop 3P output | A new request-path guard — images are already guarded |
| D3 | Labelling Grok traffic + widening the surface taxonomy | A new usage backend — the log and filter exist |
| D4 | Same fix as D1b plus an explicit "unknown" display | A wrong constant — nothing is set to 200k |

## Fix work-phase map (appended to the goalplan, dependency-ordered)

| WP | Slice | Depends on |
|----|-------|------------|
| WP6 | D1a+D1b+D4: context formatting + native windows + unknown display | — |
| WP7 | D1c: surface supports1m/prefer1m on the Desktop DTO + UI chip/toggle | WP6 |
| WP8 | D3: widen usage surface taxonomy, label Grok traffic, add the tag | — |
| WP9 | D2: Desktop 3P output schema guard | — |

Each gets a diff-level decade doc (`060`-`090`) before implementation, per the unit's
existing docs-first contract.
