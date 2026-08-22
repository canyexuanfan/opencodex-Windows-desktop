# 000 — Bug merge-train triage matrix (2026-08-21)

Session: 01a024bb-1acb-7633-908b-29e4fe4d96c5 (worktree a6a7, detached at c0cbe494e).
Objective: drive the six open bug-labeled PRs to merged on `dev` with strict review,
adversarial xai/grok-4.6 subagent verdicts, and a final green dev CI gate.

## In-scope PRs (state as of 2026-08-21T14:30Z)

| PR | Title | Head | Behind dev | Draft | CI on head | Existing review state |
|----|-------|------|-----------:|-------|------------|----------------------|
| #2294 | fix(release): reject credential-bearing SSH remotes | 71598fa45 + hardening 2cdfba24d (train-stacked) | 3 | yes | green | MERGED to train; grok blocker fixed; re-verdict PASS; landing on dev |
| #2289 | fix(service): restart existing installs w/o re-register | 240fc9364 (fix/2287-service-restart) | 9 | yes | green incl. Service lifecycle | none; Closes #2287 |
| #2295 | fix(codex): recover zero-byte coordinator remnants | 6d5f0cf2c (ingw/fix-zero-byte-coordinator-2291) | 0 | yes | green | MERGED to train 728ca1e8b; suite green; landing on dev |
| #2270 | fix(responses): apply_patch on routed Responses | 398b7ade4 (fix/apply-patch-routed-lowering) | 48 | yes | Ingwannu: two CHANGES_REQUESTED resolved on this head; third review says no remaining technical blocker | Linux shards green |
| #2281 | fix: call_id thought-signature replay for Claude Code | b31f3dbed (fix/claude-code-thought-signature-replay) | 50 | no (review-ready + hygiene-blocked label) | BLOCKED state | CodeRabbit minor: normalize promptCacheKey via anthropicSessionKeyFromParts before storing as clientThreadId (core.ts ~1888-1896); lidge-jun review priority 63/80 confirms repro |
| #2296 | fix(codex): bind Desktop reconnects to one pool account | e672b0fd0 + scope fix 698228e40 (train-stacked) | 2 | yes | green | MERGED to train; grok major fixed; re-verdict PASS; landing on dev |

## Baseline dev CI status (pre-train blocker)

Run 32486877508 on dev head c0cbe494e: attempt 1 **failed** on
`(fail) multiAgentGuidanceText > the v2 default catalog path uses the request collector, not the synchronous one (#1852)` (macos job). Rerun of failed jobs (attempt 2) is **green** (conclusion: success), and the test passes locally at c0cbe494e (52/52). Cycle 1 exits as recorded flake per 010; no direct dev push needed. Watch for recurrence during the train.

## Hygiene notes

- #2281 carries `intake: hygiene-blocked` (missing_regression_test) despite having test files — the label state needs re-check after any new commit.
- #2281 is a first-time contributor PR; gate binds completion to exact head. New commits reset the checklist; since we (maintainer) will merge manually, that is acceptable.
- User authorized: stash/merge/cherry-pick/close/extra commits, push with --no-verify, suite on ssh lidge if needed, final CI green on dev is the exit gate.
