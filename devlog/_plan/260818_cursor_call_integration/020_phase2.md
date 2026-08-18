# 020 — WP3: full remote verification on ssh lidge

Revised by audit `r1` finding F5: `privacy:scan` and `audit:high` run HERE, before
the PR, not after the merge.

## Why remote, and why the FULL suite

The campaign touches `src/bridge.ts`, `src/adapters/google.ts`,
`src/adapters/anthropic.ts`, `src/adapters/command-code.ts` — shared runtime, not a
scoped adapter change. `AGENTS.md` §Commands requires `bun run typecheck` and
`bun run test` before a non-trivial PR is review-ready.

Standing user contract: the authoritative suite runs on `ssh lidge`, never locally.

Remote checkout: `/home/lidgeai/Developer/opencodex`, bun 1.3.14, 16 cores.

`--isolate` is required: the flat suite bleeds environment between files without it.

## Procedure (verification only, no MODIFY)

```
ssh lidge 'cd ~/Developer/opencodex && git fetch origin cursor-call && git checkout -f <SHA> && git log --oneline -1'
ssh lidge 'cd ~/Developer/opencodex && bun install --frozen-lockfile'
ssh lidge 'cd ~/Developer/opencodex && bun x tsc --noEmit'
ssh lidge 'cd ~/Developer/opencodex && bun run privacy:scan'
ssh lidge 'cd ~/Developer/opencodex && bun run audit:high'
ssh lidge 'cd ~/Developer/opencodex && bun test --isolate tests'
```

`audit:high` and `privacy:scan` are in `scripts/release.ts:374,380` — the release
authority runs both, so they belong before a merge that claims release readiness.

Run the suite as a managed background session (~8 min) and poll; do not block a
turn on it.

## Expected evidence

- `bun x tsc --noEmit` → exit 0, no output.
- `bun run privacy:scan` → exit 0.
- `bun run audit:high` → exit 0. If it reports a pre-existing advisory that also
  fails on `origin/dev`, record that comparison rather than attributing it to this
  branch.
- `bun test --isolate tests` → **0 fail**. Pass counts move because dev added 104
  commits of tests; the bar is 0 fail, not a count. (Prior data points: 12761 pass
  at the old base, 12800 at the campaign tip.)

## Platform gap (state it, do not paper over it)

lidge is Linux. Repository CI covers Linux, Windows, and macOS. Windows-specific
surfaces (shims, installer, PowerShell) are historically where this repository
breaks. This campaign touches none of them — record that as the reason the Linux
evidence is *adequate for this diff*, rather than implying Linux equals CI.

## Known flake (do NOT call it a regression without isolation)

`tests/request-pacing.test.ts` and `tests/codex-auth-api.test.ts` have failed under
parallel load and passed in isolation on BOTH the pre- and post-campaign SHAs. If
either fails, re-run that file alone first.

## Repair discipline

LOOP-REPAIR-01: read the failure delta, repair only that delta, re-verify. Two
consecutive failed repairs of the same failure → root-cause mode. Three → back to P
with a changed plan.

## Verification (C)

Typecheck exit 0, privacy:scan exit 0, audit:high exit 0, and a `0 fail` line from
`bun test --isolate tests` — each quoted with the SHA it ran against.

