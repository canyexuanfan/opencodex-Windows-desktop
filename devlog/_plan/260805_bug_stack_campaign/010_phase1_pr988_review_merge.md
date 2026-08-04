# 010 — Phase 1: PR #988 design review, small fixes, merge

## Goal

Land the only CI-clean bug PR (#988, Wibias: GUI providers quota/auth, Claude
pool toggle, combos/models layout, dev session bootstrap) after verifying it
against the repo's GUI design system. Fix only small deviations; no redesign.

## Review protocol (B of this phase)

This document is the review protocol; the concrete file-by-file verdicts and
any correction diff are appended here at this phase's own cycle P after the
actual PR diff is read, making 010 the complete record before its B starts.

1. Fetch the PR head into a local branch (`codex/review-pr988`) from
   `origin/dev` — never commit on top of the detached other-unit HEAD.
2. Read the full diff (`gh pr diff 988`).
3. Check against the design contract:
   - tokens: new spacing/typography uses existing CSS custom properties and
     the shared token files, no one-off magic values where a token exists;
   - UX states: loading/empty/error states keep their meaning
     (UX-STATE-01) — the removed "Loading combos..." line must be replaced by
     the documented `aria-busy` contract, not by silence;
   - accessibility: the pool toggle is a real switch control with
     `aria-pressed`/`role=switch`; capacity-warning contrast claim (WCAG AA)
     holds in both themes;
   - emoji ban: no emoji as UI visual elements;
   - the `/opencodex-session` dev bootstrap does not weaken the session
     contract for packaged builds (server-side change in
     `src/server/gui-static.ts` / `src/server/index.ts` gets the same read as
     the GUI files).
4. Verify: `bun run typecheck`, `bun run lint:gui`, `bun run build:gui`,
   focused GUI tests (`cd gui && bun test tests`), plus
   `bun test tests/provider-workspace-auth.test.ts tests/server-management-auth.test.ts`.
   Full `bun run test` on `ssh lidge` if any non-GUI file was touched by a
   fix.
5. If deviations are found: apply the smallest correction on the PR branch
   (author's fork permitting) or carry a follow-up commit on top of the merge.
6. Merge: `gh pr merge 988 --repo lidge-jun/opencodex --merge` (user
   authorized). Confirm the merge commit on `origin/dev`.

## Scope boundary

- IN: the 24 files in the PR diff, corrections within their existing lines.
- OUT: any redesign, token system changes, new components, other providers'
  pages, the CodeRabbit docstring-coverage warning (repo has no docstring
  convention; not a blocker).

## Accept criteria

- Review verdict recorded here with file:line citations for any fix applied.
- All gates in step 4 pass; evidence pasted into the phase record.
- `gh pr view 988 --json state` shows `MERGED`; `origin/dev` contains the
  merge commit.
