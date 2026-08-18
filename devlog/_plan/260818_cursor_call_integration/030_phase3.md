# 030 — WP4: the stacked pull requests against dev

Rewritten three times. `r1` F4 killed a fabricated adapter/bridge/docs split. `r3`
F3 showed an honest stack DOES exist at the campaign's phase boundaries. `r4` F2
then showed the version written from that was not constructible: the ranges were
miscounted, PR1-owned files were edited in the top range, and rebasing rewrites the
very boundary SHAs the plan named.

## The stack, by OWNERSHIP not by original commit order

The layers are defined by which subsystem they change. The rebase must produce a
history where each layer is contiguous, and the plan's job is to say how.

| PR | Head branch | Base | Owns |
|----|-------------|------|------|
| 1 | `cursor-call-wire` | `EXPECTED_DEV` | Cursor wire: `cursor-errors.ts`, `live-transport.ts` (EOF resolution), `native-exec.ts`, `protobuf-request.ts`, `request-builder.ts`, `protobuf-events.ts` (WP2b), tests `cursor-eof-terminal`, `cursor-request-builder`, `cursor-tool-result-image`, `cursor-interaction-query`, decode docs 000-030 |
| 2 | `cursor-call-cancel` | PR1 head | Unexpected CANCEL: `cursor-errors.ts`, `live-transport.ts` (`classifyTurnFailure`), `tests/cursor-cancel-provenance.test.ts`, decode doc 040 |
| 3 | `cursor-call` | PR2 head | Bridge/adapter terminals: `bridge.ts`, `truncated-stop-reason.ts`, `google.ts`, `anthropic.ts`, `command-code.ts`, their 4 tests, decode doc 050, this integration unit |

The layering is real, not cosmetic: PR2's `classifyTurnFailure` reads the
`emittedTerminal` flag PR1 introduces (absent from `live-transport.ts` at
`dfb6fb884`, present at `6d9744283` — verified), and PR3's bridge terminal logic is
what makes PR1/PR2's adapter error events reportable instead of silently dropped.

## Why the naive commit-range split fails (r4 F2)

Measured, not assumed:

- `<base>..dfb6fb884` = 17 commits — clean, PR1's original run.
- `dfb6fb884..6d9744283` = 3 commits — clean, PR2's original run.
- `6d9744283..fe2237038` = 11 commits; `6d9744283..HEAD` = 16.

The top range is NOT pure PR3 work. `git diff --name-only 6d9744283 cursor-call`
shows it also touches `src/adapters/cursor/request-builder.ts`,
`tests/cursor-request-builder.test.ts`, and `tests/cursor-tool-result-image.test.ts`
— PR1-owned files edited later by `2ea12062d` (the r2 honesty corrections). And the
rebase REWRITES `dfb6fb884` and `6d9744283`, so those SHAs cannot be named as
branch points afterwards.

## Procedure (this is the part r4 said was missing)

Run AFTER the WP2 rebase and the WP2b patch, in the rebased history.

1. **Record the rewritten boundaries.** The rebase preserves commit order, so map by
   subject line rather than by SHA:

       git log --format='%h %s' EXPECTED_DEV..cursor-call

   `PR1_TIP` = the rewritten commit whose subject is
   `docs(devlog): record what shipped for 010 and 020, and why 030 did not`.
   `PR2_TIP` = the rewritten
   `docs(devlog): record what shipped for 040`.
   Verify each with `git show --stat` before using it.

2. **Move the late PR1 edits below `PR1_TIP`.** The r2 honesty corrections to
   `request-builder.ts` and the two cursor tests belong to PR1's subsystem. Rather
   than reorder history (which `r1` F4 correctly warned against), fix it forward:
   cherry-pick just those hunks into a small commit placed on `cursor-call-wire`,
   and let the original commit on the top layer become a no-op for those files
   during the retarget. If the cherry-pick is not clean, do NOT force it — split the
   original commit with `git rebase -i` instead, and record which route was taken.

3. **Land WP2b inside PR1.** WP2b edits `protobuf-events.ts` and
   `cursor-eof-terminal.test.ts`, both PR1-owned, and its whole reason for existing
   is PR1's EOF resolution. Commit it on `cursor-call-wire` before `PR1_TIP` is
   branched, not on the tip. `015` is written as a WP2b work-phase precisely so it
   exists before the stack is cut.

4. **Create the branches:**

       git branch cursor-call-wire   <PR1_TIP>
       git branch cursor-call-cancel <PR2_TIP>
       # cursor-call itself is PR3's head

5. **Re-verify the split before opening anything:**

       git rev-list --count EXPECTED_DEV..cursor-call-wire
       git diff --name-only EXPECTED_DEV cursor-call-wire
       git diff --name-only cursor-call-wire cursor-call-cancel
       git diff --name-only cursor-call-cancel cursor-call

   Each file set must match its Owns column. A PR1 file appearing in PR3's diff
   means step 2 is unfinished — stop rather than opening a mislabeled PR.

## Policy constraints (`AGENTS.md`)

- `dev` is the only integration target. Never `main`.
- Stacked children targeting an OPEN parent's head branch are an intentional
  workflow; `enforce-target` skips the wrong-base gate for them
  (`AGENTS.md:218-225`). Retarget each child to `dev` after its parent lands.
- `.github/PULL_REQUEST_TEMPLATE.md` requires **Summary**, **Verification**,
  **Checklist**; `enforce-target` rejects thin descriptions.
- Each layer carries its OWN verification evidence (`AGENTS.md:178-180`), per `020`.

## Description content

- **Summary** — the defect and the wire behavior before/after. Two honest notes are
  mandatory: (a) in PR1, that dev independently fixed the clean-EOF defect and our
  surviving contribution is `emittedTerminal` plus one guard plus WP2b's usage fix;
  (b) wherever tool-result images appear, that the ENCODER supports them and
  production does not reach it because all Cursor models are in `noVisionModels`.
- **Verification** — that layer's own commands, output, and SHA. Not the tip's.
- **Checklist** — three boxes, honestly, with the `docs-site/` determination made
  here rather than deferred.
- No `Closes #`.

## Verification (C)

```
gh pr list --state open --json number,baseRefName,headRefName,title
gh pr view <n> --json body
```

PR1 base `dev`; PR2 base `cursor-call-wire`; PR3 base `cursor-call-cancel`; the
step-5 file-set checks recorded; all three template sections non-thin in each.

