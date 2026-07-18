# Work phase 030 — integration, adversarial QA, and closeout

## Outcome

Prove the account and rail slices together against the latest repository state, repair only evidence-backed residuals, synchronize the design-system SoT, and close the goal with reproducible receipts.

## Scope

- Production edits are default-out. Any repair must be a P amendment naming the observed failing file/path and activation evidence.
- Test/evidence updates may touch the focused test files, `docs/design-system/components.md`, this unit's final verification section/evidence directory, and the bound goalplan/ledger.
- No release, version bump, deployment, push, account deletion, or permanent live account change.

## P stale check

- Re-read `010_account_switcher.md` and `020_provider_rail.md` against HEAD.
- Inspect all commits from both work phases and classify test changes as required/suspicious/unrelated.
- Record any hypothesis that died or any criterion that did not improve; do not restart from aggregate “looks better” judgment.

## Verification sequence

1. Contract and focused tests:

   ```sh
   bun test --isolate tests/provider-workspace-auth.test.ts tests/provider-workspace-rail.test.ts tests/oauth-accounts-api.test.ts tests/oauth-store-multi.test.ts tests/oauth-public-surface.test.ts tests/codex-auth-api.test.ts tests/provider-workspace-data.test.ts tests/provider-workspace-state.test.ts
   ```

2. Static/i18n/build/privacy:

   ```sh
   bun run typecheck
   cd gui && bun run lint:i18n
   cd gui && bun run build
   bun run privacy:scan
   git diff --check
   ```

3. Existing lint debt:

   ```sh
   cd gui && bun run lint
   ```

   Report the pre-existing `ProviderOverview.tsx` hook error separately if unchanged. New errors are blockers.

4. Affected/full suite:

   ```sh
   bun run test
   ```

5. Live account contract:
   - Capture original generic OAuth and Codex active IDs in process memory without printing them.
   - In the workspace Accounts tab, switch Anthropic to the other masked account; observe one PUT, refreshed selected state, and persistence after reload.
   - Restore the original Anthropic account and verify.
   - In canonical OpenAI Accounts, switch/prepare another account only if the current mode semantics make the action reversible; verify the documented next-session message, then restore the original ID.
   - Never delete, add, redeem credits, or change auto-switch.

6. Browser matrix with requested and effective CSS width recorded:

   ```text
   desktop 1440: Accounts tab, many rows, rail, detail overview
   split 1024: rail/detail composition, long names, no horizontal overflow
   tablet 768: actual client width recorded; force lower requested width if needed to cross 760 CSS px
   mobile 390: stacked rail/detail, touch controls
   narrow 320: no Korean/English clipping or vertical glyph stacking
   themes: light + dark
   locales: en + ko mandatory; de + zh smoke for expansion
   states: loading, empty, error, one, many, reauth, switching, restored success
   keyboard: rail arrows/Home/End; detail tabs arrows/Home/End; account/action Tab order
   console/network: no framework overlay/error; expected account GET/PUT and quota refresh only
   motion: feedback-only; reduced-motion removes transition/spinner animation where applicable
   ```

7. Independent final review:
   - Fresh reviewer, different model family from the builder/research Sol agents.
   - Security: no token/raw ID/PII regression, canonical provider gating, failed mutation honesty, stale request ownership.
   - UX: account tab IA, active/error semantics, keyboard path, rail hierarchy, responsive screenshots, original brand colors.
   - Coverage ledger: every changed implementation file reviewed.

## Repair policy

- First failure: record exact delta and patch only that delta.
- Second same-class failure: enter root-cause mode before another patch.
- Third: return to P with changed plan or close honestly as BLOCKED/UNSAFE/NEEDS_HUMAN.
- Reviewer FAIL requires blocker RCA and same-reviewer re-audit; only pass or main-judged near-pass advances.

## Done evidence

- Commit hashes for docs-only roadmap, account slice, rail slice, and integration closeout.
- Persisted screenshots/evidence paths for every required width/state family.
- Goalplan tasks done and every met criterion has non-empty captured evidence.
- `cxc loop validate` passes, FSM closes through D to IDLE, then `update_goal complete` succeeds.
- Final terminal result names `DONE`, `NOOP`, `BLOCKED`, `UNSAFE`, `NEEDS_HUMAN`, or `BUDGET_EXHAUSTED`; no push occurs without explicit approval.
