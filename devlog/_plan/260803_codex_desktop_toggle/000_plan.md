# Client integration switches: Codex, Claude Desktop, and the memory they need

Split out of `260803_integrations_toggle_all` after its fourth audit. That unit
shipped Claude Code and Grok. This one was scoped around a durable
operation-state engine — and a research cycle against the real code says that
engine solves the wrong problem.

> **Re-planned 260803 after four research passes.** The rollback engine
> (`010_operation_state.md`, never written) is **dropped**. Evidence:
> `001`-`004`. The replacement is smaller, and it also fixes a defect in the
> toggle we shipped hours ago.

## The requirement in the owner's words

> "스위치를 꺼도 프록시는 살아있어야 돼. 코덱스 말고 다른 것만 켜고 싶을 수도 있잖아."

Turning a client off must leave the proxy running and serving every other
client. That is two obligations: the mutation must not stop the proxy, and the
OFF must survive a restart.

## What the research changed

| Prior claim | What the code says |
|---|---|
| Codex needs a durable operation-state engine | `ocx restore` already restores native Codex **without stopping the proxy** (`src/cli/help.ts:18`), and `ocx restore back` is the enable direction. Both exist. (`001`) |
| Desktop removal is impossible to do safely | Anthropic documents that a selected config without a valid `inferenceProvider` launches **standard mode**. We aim at that instead of guessing. (`002`) |
| The missing piece is crash recovery | The missing piece is **desired state**. Only Claude Code has one; Grok's shipped toggle is silently re-enabled by the next `ocx start`. (`003`) |

The fourth research doc (`004`) is an unrelated live defect found while looking:
one out-of-enum modality value makes a client reject its entire config. It joins
this unit as an independent work-phase (LOOP-UNIT-CHAIN-01).

## Read first

In this unit, all four written this cycle:

- `001_native_restore_thesis.md` — Codex restore, its asymmetries, the history lock
- `002_desktop_standard_mode.md` — the official standard-mode contract, and why `default` is not the restore verb
- `003_durable_desired_state.md` — desired vs observed, the Grok regression, the schema
- `004_export_modality_poisoning.md` — the gjc/Pi enum defect

From the parent unit, still authoritative: `001_removal_path_inventory.md`
(what each disable costs) and `002_consequence_dialog_ux.md` (dialog direction).
Its `007_audit_synthesis_r4.md` is the reason this unit exists, but its central
conclusion is now **superseded** by `001`-`003` here.

## Phases

Dependency-ordered (PHASE-SPLIT-01): the schema is the foundation every switch
consumes, so it goes first even though it ships no visible switch.

| Phase | Doc | Deliverable |
|---|---|---|
| WP2 | `010_modality_boundary.md` | The client-dialect modality filter. Independent of everything else; fixes a live user-visible failure |
| WP3 | `020_desired_state.md` | `OcxConfig.clientIntegrations`, default-ON, consulted by every automatic apply path — including the Grok regression |
| WP4 | `030_api_keys_row.md` | API keys out of the card grid into their own row |
| WP5 | `040_codex_toggle.md` | The Codex switch on top of WP3, with a structured restore result |
| WP6 | `050_desktop_toggle.md` | The Desktop switch via documented standard mode |

WP1 was this cycle: the research above plus this roadmap.

WP2 and WP4 are independent of the rest and of each other. WP5 and WP6 are
parallel siblings that both depend on WP3.

## Scope boundary

IN: `src/clients/config-export.ts`, `src/types.ts`, `src/config.ts`,
`src/codex/sync.ts`, `src/grok/sync.ts`, `src/cli/index.ts`,
`src/cli/opencode.ts`, `src/claude/desktop-3p.ts`,
`src/server/management/native-integration-routes.ts`,
`src/server/management/agent-settings-routes.ts`, `src/server/management-api.ts`,
`gui/src/pages/integrations/*`, `gui/src/styles-integrations.css`,
`gui/src/i18n/*`, `tests/`, `gui/tests/`.

OUT: releases, publishing, deploys, tags; starring the repository; rewriting the
six-client file machinery in `src/integrations/`; `docs-site` restructuring;
recording the previous `appliedId` (deferred, `002` §Residual).

## Criteria

- C1 — gjc loads our emitted config with no schema error, proven from the real
  file; Pi's identical exposure is closed in the same change.
- C2 — a disabled client stays disabled across a proxy restart, an `ocx ensure`,
  and a `POST /api/sync`.
- C3 — an upgrading user with no `clientIntegrations` key sees no behavior change.
- C4 — disabling any client never stops the proxy and never disables a shared
  transport used by another client.
- C5 — Codex toggles both directions from the overview with the proxy running.
- C6 — a Codex disable blocked by the held history DB is an explained refusal
  naming the cause, never a raw 500 and never a false green.
- C7 — Desktop's disable points `appliedId` at a present, readable,
  credential-free config and removes the credential-bearing `.bak`.
- C8 — API keys render as a row above the grid, observed rendered.
- C9 — typecheck, full test, gui lint, gui test, privacy scan all green.

## Risk register

| Risk | Mitigation |
|---|---|
| A gate silently unplugs a working client on upgrade | Absent key means ON, everywhere, with a test for the absent-config case (`003`) |
| Gating a safety path | Explicit do-not-gate list: journal repair, ownership checks, owned teardown, shared transports (`003`) |
| Desktop pointed at a missing file | Never delete `appliedId`, never leave it dangling, never pick an entry by the name `Default` — this machine's `Default` is already dangling (`002`) |
| The modality fix erases valid internal metadata | Filter at the client-dialect boundary only; management and CLI keep carrying `audio` verbatim (`004`) |
| A green suite hides the real failure | 91 tests pass today beside a config gjc refuses to load. Every criterion names a live artifact, not a unit test |
