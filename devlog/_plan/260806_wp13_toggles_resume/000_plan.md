# 260806 — WP13/WP14 resume: Codex CLI toggle truth, Claude Desktop toggle, composed acceptance

PR-ONLY unit: the branch `codex/260806-wp13-toggles` (from `origin/dev` @ `b3a1d90a8`)
is pushed and opened as PR(s) against `dev`, but **never merged** in this session —
that boundary is a user instruction, not a preference.

This unit resumes the paused tail of two prior campaigns:

- `devlog/_fin/260804_codex_write_substrate/` — WP13 (composed acceptance, issue
  [#1048](https://github.com/lidge-jun/opencodex/issues/1048)) was deferred; WP14's PR
  deliverable landed as PR #998, so "WP14" here means the *new* toggle work opened as a PR.
- `devlog/_plan/260803_codex_desktop_toggle/` — 040 (Codex toggle CLI truth) and 050
  (Claude Desktop toggle) were written but never implemented.

## Stale-check verdicts (explorer audit, 2026-08-06, tree @ b3a1d90a8)

All three pre-written docs are **NEEDS AMENDMENT**, none is ALREADY LANDED, none is
implementable as written. What changed under them:

### Landed since the docs were written

- Durable `clientIntegrations` desired state exists for `codex`/`grok` only
  (`src/types.ts:551-556`, `src/config.ts:986-1012`), with owner
  `setIntegrationEnabled` (`src/codex/desired-state.ts:90`) and field-scoped
  `mutatePersistedConfig` (`src/config.ts:2197`).
- Dashboard `PUT /api/native-integrations/codex` persists intent before artifact work
  (`src/server/management/native-integration-routes.ts:58-87,199-293`); startup honors
  Codex OFF via `syncCodexOnStartIfEnabled` (`src/cli/index.ts:320`,
  `src/codex/desired-state.ts:160-176`). Tests: `tests/native-codex-toggle.test.ts:106-156`,
  `tests/codex-desired-state.test.ts:167-223`.
- Production injection runs under `withCodexWriteLock` (`src/codex/inject.ts:871-956`);
  the typed lock model exists (`src/codex/codex-write-lock.ts:67-125`) with a real
  two-process contention test (`tests/codex-inject-write-lock.test.ts:56-127`).
- c24 (Grok OFF survives restart) is **landed at unit level**: persist-before-strip
  (`native-integration-routes.ts:342-374`), startup predicate `shouldSyncGrokOnStart`
  (`src/cli/index.ts:350-354`, `desired-state.ts:58-76,195-197`), covered by
  `tests/codex-desired-state.test.ts:233-243`. No full-process E2E; the composed
  acceptance phase may add it, but c24 is not a standalone work-phase.

### Still missing (the actual work)

1. **CLI restore/eject do not persist desired state.** `ocx restore`/`eject`
   (dispatch `src/cli/index.ts:774-819`) call `restoreNativeCodexAsync` without writing
   `clientIntegrations.codex=false`; `restore back`/`eject back` do not persist ON.
   Startup would resurrect routing the CLI just removed (040's core defect, alive).
2. **No artifact-level restore truth.** `restoreNativeCodexAsync`
   (`src/codex/inject.ts:1193-1217`) reports `inline.success` even when the history
   worker fails; no per-artifact result envelope exists.
3. **`syncModelsToCodex` and `ocx ensure` are ungated** (`src/codex/sync.ts:49-129`,
   `src/cli/index.ts:379-424`): they bypass the desired-state gate.
4. **Claude Desktop has no toggle at all**: no `claude-desktop` key in
   `clientIntegrations`, no native-toggle route (union is claude|grok|codex,
   `native-integration-routes.ts:31`), auto-apply calls the writer directly ignoring
   desired state (`agent-settings-routes.ts:131-150`), status does not classify
   standard/gateway/foreign/not_installed (`agent-settings-routes.ts:767-815`), and no
   `removeDesktop3pConfig`/read-only inspect exists. 050's read-never-writes rule is
   still violated by `writeDesktop3pConfig`'s eager `mkdirSync`
   (`src/claude/desktop-3p.ts:343-345`) on the write path only — reads must never
   route through it.
5. **No composed acceptance suite.** WP13's P01-P36 doc cites pre-substrate line
   numbers and pre-substrate RED claims (lock absence, no production caller) that are
   no longer true. The surviving target: compose real entry points — CLI
   restore/eject/ensure/sync, management toggle routes, startup gate — against a temp
   home, including refusal, foreign-home, and race paths.

### External evidence (Luna swarm, 3 lanes, all sources opened)

- Anthropic's official configuration reference (claude.com/docs/third-party/
  claude-desktop/configuration, accessed 2026-08-06) now documents the configLibrary
  (`~/Library/Application Support/Claude-3p/configLibrary/`, `_meta.json` + `<id>.json`),
  gateway fields `inferenceGatewayBaseUrl`/`ApiKey`/`AuthScheme` (bearer|x-api-key),
  `inferenceModels` (string or object entries; first entry is default),
  `modelDiscoveryEnabled`, and `supports1m`/`prefer1m`. The schema-drift risk recorded
  in memory (private fields) is RESOLVED: the fields 050 relies on are documented.
- No official spec for behavior when the selected `<id>.json` is missing — community
  evidence shows "configuration needs attention" symptoms only (UNVERIFIED). 050's rule
  stands: never leave `appliedId` pointing at a missing file; select the standard `{}`
  profile before removing ours.
- No native 1P-restore control is documented; community tools restore standard mode by
  selecting an official/empty profile then removing the 3P one — matching 050's pivot.
- Codex CLI reads config.toml at session start (restart-scoped); `model_provider`
  selects from `model_providers`; no official restore-after-proxy runbook exists, so
  our restore semantics remain artifact-based, not documented-contract-based.

## Phase map (one decade doc per PABCD cycle)

- **010 (WP-B)** Codex toggle completion, consuming existing `clientIntegrations`:
  CLI restore/eject persist OFF, restore back/eject back persist ON, artifact-level
  restore result (history failure classified, never silent), gate `ocx ensure`/`sync`
  on desired OFF. Source doc: `260803_codex_desktop_toggle/040_codex_toggle.md` with
  the line-map above; drop its four-client-coordinator premise — extend the landed
  two-key schema instead.
- **020 (WP-C)** Claude Desktop toggle per 050's amended contract: add
  `claude-desktop` to `clientIntegrations` and the native route union; read-only
  status classification (absent library = `not_installed`; reads never write); OFF =
  write+select `{}` standard profile, then remove the opencodex profile and its
  credential-bearing backup; OFF with no owned state = successful no-op; GUI switch.
- **030 (WP-D)** Composed acceptance (issue #1048): one suite through real entry
  points against temp homes — CLI process invocations, management routes, startup
  gate — covering refusal/foreign-home/race/restore truth, including the missing
  Grok E2E (disable → fresh start path → fence stays absent).
- **WP-E** Push branch, open template-complete PR(s) against dev referencing #1048,
  PR CI green. **No merge, no promotion.** dev/preview/main tips proven unchanged.

Verification per phase: `bun run typecheck`, `bun run test`, `bun run lint:gui` (gui
touched phases), `bun run privacy:scan`, temp-home live proof (`mktemp -d`; never the
real `~/.codex`/`~/.opencodex`; never `ocx start/stop/service` — launchd owns the live
proxy on :10100). Every new mechanism gets a broken-change check.
