# 040 — WP4: hardening round

Depends on WP2. Covers F2 (config overwrite), F3 verification, the adversarial review,
the full gates, and the live smoke. Audit fold-backs from `002` §6 and §8.

## H1 — protect `claudeCode` from service-time config overwrite (F2)

`src/config.ts`:

```ts
// Snapshot of the claudeCode subtree as last read/written by US (structural clone).
let lastKnownClaudeCode: unknown = undefined;
let snapshotArmed = false;                       // false until loadConfig sets it once

export function saveConfigPreservingClaudeCode(config: OcxConfig): void {
  const onDisk = readRawConfigJson();            // literal file, no schema merge
  if (snapshotArmed && onDisk !== undefined) {
    const diskChanged = !deepEqual(onDisk.claudeCode, lastKnownClaudeCode);
    const weChanged = !deepEqual(config.claudeCode, lastKnownClaudeCode);
    if (diskChanged && !weChanged) {
      // Someone hand-edited claudeCode while we ran and we have no own change to
      // defend: their edit wins instead of being clobbered.
      config.claudeCode = onDisk.claudeCode as OcxConfig["claudeCode"];
    }
    // diskChanged && weChanged -> our change wins and the snapshot rebases below.
    // Documented conflict policy; a three-way merge is out of scope (002 §6).
  }
  saveConfig(config);
  lastKnownClaudeCode = structuredClone(config.claudeCode);
  snapshotArmed = true;
}
```

`deepEqual` is a structural compare on the PARSED subtrees, not `JSON.stringify` —
key order must not decide whether a user's hand edit survives (002 §8).

**The guard cannot be per-writer** (audit R2-5). The decisive counterexample:
`model-routes.ts:226-227` changes only `disabledModels` and calls `saveConfig(config)`,
which serializes the WHOLE object (`config.ts:847-859`) — so an unrelated model toggle
clobbers a hand-edited `claudeCode`. Enumerating `claudeCode` mutators protects
nothing against that.

So the guard sits in **one save wrapper used by every service-time save**:
`saveConfigPreservingClaudeCode` becomes the entry point for routes and CLI commands
that hold a long-lived server config, including the writers the first list missed —
combo migration (`combo-routes.ts:164-182`) and CLI Desktop
(`claude-desktop.ts:117-119`, `:135-138`) — as well as the direct `claudeCode`
mutators (claude-code PUT, Desktop auto-apply `agent-settings-routes.ts:95-96`,
Desktop profile routes `:498-499`, `:510-511`, `:531-532`).

Explicitly **out of scope**: preserving non-`claudeCode` subtrees. A hand edit to
`providers` is still clobbered — the earlier "preserved naturally" claim was false and
is retracted. Widening the wrapper to reconcile the whole config is a separate unit;
this one records the residual and asserts it in a test so it cannot drift into an
assumed guarantee.

Edge semantics, chosen deliberately:

- WE changed the subtree in memory AND the user edited the file → our save wins and
  the snapshot updates (their next edit starts from the new baseline). A three-way
  merge is out of scope.
- File unreadable/missing at save time → behave as before (save what we have); never
  fail a save over protection.

Tests (`tests/config-user-edits.test.ts`, NEW):

- hand-edit `claudeCode` on disk while the service holds memory → guarded save keeps
  the hand edit;
- **the R2-5 integration case**: hand-edit `claudeCode`, then invoke an UNRELATED
  model-visibility PUT → the hand edit survives (this is the test that would have
  failed under the per-writer design);
- in-memory change to `authMode` + disk edit → in-memory wins, snapshot rebases, and
  the NEXT hand edit starts from the new baseline;
- key-order-only difference on disk → treated as EQUAL (structural compare), so no
  spurious "external edit" branch;
- **TOCTOU seam**: an edit landing between the raw read and the atomic write is the
  known race; the injectable read/write seam drives it deterministically and the test
  pins the documented outcome rather than pretending it cannot happen;
- unreadable/missing file → save proceeds, no throw;
- a `providers` hand edit is NOT preserved (asserted, so the documented residual
  cannot silently drift into an assumed guarantee).

## H2 — F3 verification (settings.json env hijack)

No new defence in this unit — an honest coverage check instead:

- test that `buildClaudeEnv` with a host token emits `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  (exists) and that auto→proxy (host token present) also emits it — NEW case;
- document in the D summary that subscription mode carries no hijack defence by design
  (the flag without a token is F4), so the residual is a documented tradeoff, not an
  accident.

## H3 — adversarial review + gates + live smoke

- Independent reviewer on the whole unit's diff (a FRESH agent — the plan reviewer is
  contaminated by having authored the blocker list).
- Full gates: `bun run typecheck`, `bun run test`, `cd gui && bun run test`,
  `bun run lint:gui`, `bun run lint:i18n`, `bun run privacy:scan`.
- Live smoke (c-smoke) on THIS machine (auth present via S1 + S3):
  `bun src/cli/index.ts claude --version`-equivalent env dump — assert
  `ANTHROPIC_AUTH_TOKEN` is NOT injected and the mode resolves subscription.
  Absent case: fixture home (`HOME`-redirected deps in a unit test already; for the
  smoke, run the resolver against an empty temp home and show auto→proxy).
  Feedback-loop case: pre-set `ANTHROPIC_AUTH_TOKEN=opencodex-proxy` in the smoke env
  and show it is DELETED on the subscription resolution.

## D-phase record

`050_closeout.md`: terminal outcome, evidence per criterion, what did NOT improve
(LOOP-PESSIMIST-01) — expected residuals: F3 (subscription mode carries no
settings.json hijack defence by design, because the flag without a token is F4),
#488's non-`claudeCode` subtrees still unprotected, and the save TOCTOU window.
