# 020 — WP3: full remote verification on ssh lidge

Revised by audit `r1` F5 (gates moved before the PR) and audit `r3` F1+F2 (base
pinning, and never `checkout -f` a shared checkout).

## Why remote, and why the FULL suite

The campaign touches `src/bridge.ts`, `src/adapters/google.ts`,
`src/adapters/anthropic.ts`, `src/adapters/command-code.ts` — shared runtime, not a
scoped adapter change. `AGENTS.md` §Commands requires `bun run typecheck` and
`bun run test` before a non-trivial PR is review-ready.

Standing user contract: the authoritative suite runs on `ssh lidge`, never locally.

lidge: `/home/lidgeai/Developer/opencodex`, bun 1.3.14, 16 cores.

`--isolate` is required: the flat suite bleeds environment between files without it.

## Use a DEDICATED worktree, never `checkout -f` the shared clone (r3 F2)

`~/Developer/opencodex` is a shared working checkout, and `git checkout -f` there
would silently discard any tracked uncommitted work. `git worktree list` on lidge
already shows a dozen `/tmp/ocx-*` verification worktrees, so this is the
established pattern there:

```
ssh lidge 'cd ~/Developer/opencodex && git fetch origin cursor-call dev'
ssh lidge 'cd ~/Developer/opencodex && git worktree add /tmp/ocx-cc-<SHORTSHA> <SHA>'
ssh lidge 'cd /tmp/ocx-cc-<SHORTSHA> && git log --oneline -1'
ssh lidge 'cd /tmp/ocx-cc-<SHORTSHA> && bun install --frozen-lockfile'
```

`<SHA>` is the tip pushed at the END of WP2b, not `010`'s post-rebase checkpoint
push (audit `r8`). WP2b changes code after `010` step 7 runs, so verifying the
earlier tip would authoritatively bless a tree without WP2b in it. Both work-phases
push and assert `git ls-remote` matches `git rev-parse cursor-call`; this phase
consumes the later one. Confirm the SHA here too before installing:

```
ssh lidge 'cd ~/Developer/opencodex && git rev-parse origin/cursor-call'   # == local rebase tip
```

Remove the worktree when the phase closes (`git worktree remove`), and never touch
the shared checkout's HEAD.

## Pin the base (r3 F1), and remember it EVOLVES (r4 F1)

`dev` moves. Record, at the moment the rebase runs:

```
git ls-remote origin refs/heads/dev     # LIVE head, not the tracking ref
```

That SHA is `VERIFIED_BASE`, and it is what `010` step 1 rebases ONTO — not
`origin/dev`, which can be minutes stale (`scripts/release.ts:327-335` uses
`ls-remote` for exactly this reason). Observed drift during planning alone:
`87f7f970b` → `e1bdbc1e5` → `1645bb924`.

`VERIFIED_BASE` is the value `040` checks before merging PR1. It then becomes each
layer's merge result in turn (`040`'s `EXPECTED_DEV`), because after PR1 lands the
live `dev` head legitimately differs from the original.

## Gates

```
bun x tsc --noEmit
bun run privacy:scan
bun run audit:high
bun test --isolate tests
bun run build:gui        # see r3 F4 — publish runs this unconditionally
```

`audit:high` and `privacy:scan` are in `scripts/release.ts:374,380`.
`build:gui` is here because `prepublishOnly` (`package.json:49`) runs it on every
publish regardless of whether `gui/` changed, and it also runs `prepare:package`.
"No gui/ path changed" is therefore not a reason to skip it for a readiness claim.

Run the suite and the gui build as managed background sessions and poll.

## Expected evidence

- `bun x tsc --noEmit` → exit 0, no output.
- `bun run privacy:scan` → exit 0.
- `bun run audit:high` → exit 0. If it reports a pre-existing advisory that also
  fails at `VERIFIED_BASE`, record that comparison rather than blaming this branch.
- `bun test --isolate tests` → **0 fail**. Pass counts move as dev grows; the bar is
  0 fail. (Data points: 12761 at the old base, 12800 at the campaign tip.)
- `bun run build:gui` → exit 0.

## Platform gap (state it, do not paper over it)

lidge is Linux. Repository CI covers Linux, Windows, and macOS. This campaign's
28-path diff contains no shim, installer, PowerShell, platform dispatch, or Windows
path handling — verified in audit `r3`. That is why Linux evidence is adequate *for
this diff*, and it is not a claim that Linux equals CI.

## Known flake (do NOT call it a regression without isolation)

`tests/request-pacing.test.ts` and `tests/codex-auth-api.test.ts` have failed under
parallel load and passed in isolation on BOTH the pre- and post-campaign SHAs. If
either fails, re-run that file alone first.

## Repair discipline

LOOP-REPAIR-01: read the failure delta, repair only that delta, re-verify. Two
consecutive failed repairs of the same failure → root-cause mode. Three → back to P
with a changed plan.

## Verification (C)

Typecheck, privacy:scan, audit:high, and build:gui each exit 0, and `0 fail` from
`bun test --isolate tests` — each quoted with the SHA it ran against, plus the
recorded `VERIFIED_BASE`.

## Record `VERIFIED_TIP` (audit `r10`)

The SHA these gates ran against is the ONLY tree this campaign has authoritative
evidence for. Name it:

    VERIFIED_TIP=$(git rev-parse cursor-call)     # after WP2b's push, before any gate

Every later phase binds to it: `030` refuses to cut branches unless `cursor-call`
still equals `VERIFIED_TIP`, and `040` compares each PR's `headRefOid` against its
expected SHA immediately before merging. Without that chain, a force-push to any PR
head could introduce commits nobody verified while `040`'s post-merge ancestry check
still passes — the verified tip stays an ancestor either way.

## Per-layer verification (r3 F3)

Because `030` now opens a real 3-PR stack, each layer needs its own evidence
(`AGENTS.md:178-180`). Full suite on the TOP of the stack; per-layer verification is
typecheck plus the tests that layer owns:

| Layer | Focused tests |
|-------|---------------|
| PR1 (Cursor EOF + tool-result wire) | `tests/cursor-eof-terminal.test.ts`, `tests/cursor-hardening.test.ts`, `tests/cursor-tool-result-image.test.ts`, `tests/cursor-request-builder.test.ts` |
| PR2 (unexpected CANCEL) | `tests/cursor-cancel-provenance.test.ts`, `tests/cursor-hardening.test.ts` |
| PR3 (bridge/adapter terminals + **WP2b**) | `tests/bridge-nonstreaming-terminal.test.ts`, `tests/anthropic-error-stop-reason.test.ts`, `tests/command-code-error-finish.test.ts`, `tests/google-buffered-stop-reason.test.ts`, `tests/cursor-eof-terminal.test.ts`, `tests/cursor-interaction-query.test.ts` + FULL suite |

WP2b and `tests/cursor-interaction-query.test.ts` are BOTH in PR3 (audit `r6`
finding 3 resolved this way rather than by moving WP2b down). `r4` F4's rule was
right — a change and its contract test belong in the same layer — and the honest
placement is PR3, where WP2b lands chronologically. PR1 stays correct without it:
PR1 makes a truncated turn reportable, PR3 makes it report tokens.

`tests/cursor-eof-terminal.test.ts` appears in both PR1 and PR3 because WP2b adds
cases to it. Each layer runs the file as it stands at that layer.
