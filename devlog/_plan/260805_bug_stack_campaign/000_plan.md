# 000 — Bug stack campaign: triage the open bug surface, fix the 400 regression, stack the repairs

## Objective

As of 2026-08-05 (KST), bring the open bug surface of lidge-jun/opencodex to
the state where every item is either landed, closed with evidence, or carried
by a stacked PR grounded in code somebody actually read. Three fronts:

1. PR #988 — review against the GUI design system, small fixes if needed,
   merge to `dev` (user authorized this merge/push).
2. Full triage of open bug issues + bug/code-improvement PRs against
   `origin/dev` HEAD `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6`. Items
   already fixed on `dev` get closed with evidence; the rest enter the stack.
3. New regression: 400 `invalid_request_error` when a new Codex session/thread
   spawns against `anthropic/claude-opus-5` (2026-08-05 00:22 KST, request
   `ocx-mset3rk6-1i6`, conversation `2c0f87c664e130b3927c4884fafd8283`).
   Root-cause and fix with a regression test.

Items opened after 2026-08-05 00:00 KST are out of scope. Feature programs
(provider batches, RI router-intelligence stack, localization programs,
large infrastructure PRs) are out of scope.

## Loop spec

- Loop archetype: spec-satisfaction repair (each fix has a checkable verifier).
- Trigger: user-directed campaign, HOTL goal loop (goalplan
  `opencodex-pr-988-988-uiux-bug-pr-dev-head-close`).
- Goal: open bug surface fully dispositioned; #988 landed; 400 fixed.
- Non-goals: feature PRs, new providers, RI stack, docs-only improvements
  without code defect, anything opened after the campaign cutoff.
- Verifier: `bun run typecheck`, focused `bun test` per fix, full
  `bun run test` on `ssh lidge` (Linux baseline recorded below),
  `bun run privacy:scan`, plus per-fix activation evidence.
- Stop condition: every in-scope issue/PR dispositioned (landed / closed with
  evidence / stacked PR open with CI).
- Memory artifact: this unit + goalplan ledger.
- Resource bounds: sol-medium explorer subagents for research/verification
  (unlimited); B phases owned by the main session; wall-clock unbounded but
  checkpoint every B step with commits (LOOP-GIT-01).
- Expected terminal outcomes: DONE (all dispositioned), or per-item
  BLOCKED/NEEDS_HUMAN named with evidence.
- Escalation: push/merge only within the user-approved scope (#988 merge,
  stack PR creation, evidence-based closes).

## Environment baselines

- `origin/dev` HEAD: `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6`.
- Worktree: `/Users/jun/.codex/worktrees/250c/opencodex`, detached at
  `9289891a5` (other unit's commits, contained in local `dev`; stack branches
  fork from `origin/dev`, not from this HEAD).
- lidge Linux baseline (`bun run test` on dev HEAD, 2026-08-05): the first
  cold-cache run showed 12 fails with a phantom
  `ROLLUP_COST_SEMANTICS_VERSION` import error (an identifier that exists
  nowhere in the repo) plus storage/keyring suites — a first-run module-cache
  race, not repo state. Warm-cache rerun: **8212 pass / 10 skip / 0 fail,
  EXIT=0** (`/tmp/ocx-baseline-test2.log` on lidge). Campaign deltas are
  measured against the green warm baseline.

## Work-phase map

Honest dependency structure (amended after audit round 1): only three real
dependencies exist — phase 2 builds on the 003 probes, phase 3's core.ts
cluster (stack 02/03/05) must be internally ordered, and each phase-4
disposition waits for its corresponding landing. Everything else is
independent and does not inherit merge blockage from earlier items.

| Phase | Doc | Content | Depends on |
|-------|-----|---------|------------|
| 0 | this doc + 001/002/003 | triage + research (docs-only) | — |
| 1 | 010 | PR #988 design review + merge | none (independent GUI slice) |
| 2 | 020 | anthropic empty-body-400 observability + bounded retry | 003 probes |
| 3 | 030 | stack: confirmed unresolved bugs (core.ts cluster ordered; rest parallel-lane) | 001/002 triage |
| 4 | 040 | dispositions: #806 close (immediate, triage-only); supersede-closes per landing | 001/002 + phase 3 landings |

Phase 3 slices by subsystem ownership, not effort; each stack PR is one
logical change with its own focused test. Only the `core.ts` cluster chains
branches; the independent items get their own branches from `origin/dev` and
their diff-level sub-doc (`031_*`…) written at their own cycle's P
(LOOP-UNIT-CHAIN-01), which is when each becomes an executable plan.

## Triage inputs

- `001_issue_triage.md` — 38 open issues (sol-medium lane A).
- `002_pr_triage.md` — 30 open PRs (sol-medium lane B).
- `003_anthropic_400_research.md` — 400 regression research (lane C + local
  log analysis).
