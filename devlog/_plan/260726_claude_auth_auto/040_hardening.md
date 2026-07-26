# 040 — WP4: hardening round

Depends on WP2. Covers F2 (config overwrite), F3 verification, the adversarial review,
the full gates, and the live smoke.

## H1 — protect `claudeCode` from service-time config overwrite (F2)

`src/config.ts`:

```ts
// At load, snapshot the claudeCode subtree (deep clone) in a module-level slot.
let lastLoadedClaudeCode: string | null = null;   // JSON of the subtree at loadConfig

export function saveConfigPreservingUserEdits(
  config: OcxConfig,
  protect: "claudeCode",
): void {
  const onDisk = readRawConfigJson();           // no schema merge — the user's literal file
  const diskSubtree = JSON.stringify(onDisk?.claudeCode ?? null);
  const memorySubtree = JSON.stringify(config.claudeCode ?? null);
  if (
    lastLoadedClaudeCode !== null
    && diskSubtree !== lastLoadedClaudeCode      // the file changed since we loaded it
    && memorySubtree === lastLoadedClaudeCode    // and WE did not change it in memory
  ) {
    // External edit wins: someone hand-edited claudeCode while we ran, and we have
    // no own change to that subtree to defend. Preserve it instead of clobbering.
    config.claudeCode = onDisk.claudeCode;
  }
  saveConfig(config);
  lastLoadedClaudeCode = JSON.stringify(config.claudeCode ?? null);
}
```

Callers: the management routes that mutate `config.claudeCode` (`agent-settings-routes.ts`
claude-code PUT and the Desktop apply path) switch to the guarded save. Other
`saveConfig` callers are untouched in this unit — F2 is scoped to the subtree this
feature owns; widening is a separate decision.

Edge semantics, chosen deliberately:

- WE changed the subtree in memory AND the user edited the file → our save wins and
  the snapshot updates (their next edit starts from the new baseline). A three-way
  merge is out of scope.
- File unreadable/missing at save time → behave as before (save what we have); never
  fail a save over protection.

Tests (`tests/config-user-edits.test.ts`, NEW):

- hand-edit `claudeCode` on disk while the service holds memory → guarded save keeps
  the hand edit;
- in-memory change to `authMode` + disk edit → in-memory wins, snapshot rebases;
- unrelated subtree changed on disk (e.g. providers) → preserved naturally because
  only claudeCode is compared;
- unreadable file → save proceeds, no throw.

## H2 — F3 verification (settings.json env hijack)

No new defence in this unit — an honest coverage check instead:

- test that `buildClaudeEnv` with a host token emits `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`
  (exists) and that auto→proxy (host token present) also emits it — NEW case;
- document in the D summary that subscription mode carries no hijack defence by design
  (the flag without a token is F4), so the residual is a documented tradeoff, not an
  accident.

## H3 — adversarial review + gates + live smoke

- Independent reviewer on the whole unit's diff (fresh agent — the previous reviewer
  is contaminated with this repo's plan history).
- Full gates: `bun run typecheck`, `bun run test`, `cd gui && bun run test`,
  `bun run lint:gui`, `bun run lint:i18n`, `bun run privacy:scan`.
- Live smoke (c-smoke) on THIS machine (auth present via S1 + S3):
  `bun src/cli/index.ts claude --version`-equivalent env dump — assert
  `ANTHROPIC_AUTH_TOKEN` is NOT injected and the mode resolves subscription.
  Absent case: fixture home (`HOME`-redirected deps in a unit test already; for the
  smoke, run the resolver against an empty temp home and show auto→proxy).

## D-phase record

`050_closeout.md`: terminal outcome, evidence per criterion, what did NOT improve
(LOOP-PESSIMIST-01) — expected: F3 residual documented, #488's wider config subtrees
still unprotected by design.
