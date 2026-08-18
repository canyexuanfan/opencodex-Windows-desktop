# 020 — WP3: full remote verification on ssh lidge

## Why remote, and why the FULL suite

The campaign touches `src/bridge.ts`, `src/adapters/google.ts`,
`src/adapters/anthropic.ts`, `src/adapters/command-code.ts` — shared runtime, not a
scoped adapter change. Repository policy (`AGENTS.md` §Commands) requires
`bun run typecheck` and `bun run test` before a non-trivial PR is review-ready.

The user's standing contract: the authoritative suite runs on `ssh lidge`, never
the local workstation.

Remote checkout: `/home/lidgeai/Developer/opencodex` (bun 1.3.14), currently
parked at the pre-rebase campaign SHA `1651002c59`.

`--isolate` is required: the flat suite bleeds environment between files without it
(known-good practice for this checkout).

## Procedure (MODIFY: none — verification only)

```
ssh lidge 'cd ~/Developer/opencodex && git fetch origin cursor-call && git checkout -f <SHA> && git log --oneline -1'
ssh lidge 'cd ~/Developer/opencodex && bun install --frozen-lockfile'
ssh lidge 'cd ~/Developer/opencodex && bun x tsc --noEmit'
ssh lidge 'cd ~/Developer/opencodex && bun test --isolate tests'
```

Run the suite as a managed background session (it takes ~8 minutes) and poll,
rather than blocking a turn.

## Expected evidence

- `bun x tsc --noEmit` → exit 0, no output.
- `bun test --isolate tests` → 0 fail. Pre-campaign baseline on the old base was
  12761 pass / 826 files; the post-050 campaign SHA was 12800 pass / 830 files.
  Post-rebase the count rises again because dev added 104 commits of tests; the
  bar is **0 fail**, not a specific pass count.

## Known flake (do NOT treat as a regression without isolation)

`tests/request-pacing.test.ts` and `tests/codex-auth-api.test.ts` have failed under
parallel load and passed in isolation on BOTH the pre- and post-campaign SHAs. If
either fails, re-run that file alone before calling it a regression.

## Repair discipline

LOOP-REPAIR-01: read the failure delta, repair only that delta, re-verify. Two
consecutive failed repairs of the same failure → root-cause mode, not another
patch. Three → back to P with a changed plan.

## Verification (C)

The C gate for this work-phase is the remote output itself: typecheck exit 0 and a
`0 fail` line from `bun test --isolate tests`, both quoted with the SHA they ran
against.

