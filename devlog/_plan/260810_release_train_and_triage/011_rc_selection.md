# 011 — WP1: release-candidate selection under a moving branch

The RC rule in `010` is "the newest `dev` commit holding a completed successful
Cross-platform CI run on its exact SHA". Applying it required understanding why
the newer heads keep failing to produce one.

## What actually happened

`dev` moved four times during this unit, roughly every twenty minutes:

| # | SHA | Merge | Exact-SHA Cross-platform CI |
|---|-----|-------|------------------------------|
| 1 | `dc4dd45b0` | #1368 | run **31352564082 SUCCESS** — 4/4 Linux shards, macOS `10526 pass / 0 fail` |
| 2 | `277354073` | #1398 bounded live sideband websocket frames | run 31354347276 FAILURE (macOS only) |
| 3 | `0a76ee854` | #1396 bounded reset-credit lookup responses | run 31355442090 FAILURE (macOS only) → rerun → **CANCELLED** |
| 4 | `2beeea654` | #1010 per-model cost overlay | run 31356461382 in progress |

## Root cause of the cancellation

The authorized rerun of run 31355442090 did not fail on its merits. It was
killed by policy:

```yaml
# .github/workflows/ci.yml:52-54
concurrency:
  group: cross-platform-ci-${{ github.ref }}
  cancel-in-progress: true
```

The group key is `github.ref` — the *branch*, not the commit. When #1010 merged
at 04:44:57Z, the new `dev` run superseded the in-flight rerun on the older
commit. On a branch merging a PR every ~20 minutes, and with a macOS suite that
takes longer than that, **an older `dev` commit can rarely be re-driven to
green**: any rerun races the next merge and loses.

This is not a defect to fix in this unit, and it is not #1302 (that is the
15-minute shard hang; this is an immediate supersession). It is a property of
the branch policy that any release train has to plan around.

## Consequence for the RC rule

"Prefer the live head" is unachievable on a branch this active unless the
maintainers freeze merges for the duration of a release. This train has no
authorization to freeze `dev` or to ask contributors to stop.

Two honest options remain:

1. **Release from `dc4dd45b0`** — the newest commit with a genuine green
   exact-SHA gate. Cost: omits #1398, #1396, #1010.
2. **Wait for a head that goes green on its own first run** — unbounded in
   time, since the macOS Bun 1.3.14 segfault is currently hitting a majority of
   runs and each failure needs a rerun that the next merge cancels.

Option 1 is chosen. **RC = `dc4dd45b04b2564a207b72f9c761a93e631b5299`.**

## Why omitting three commits is acceptable here

Audit blocker 2 correctly objected to calling #1398 negligible. Re-examined
with the full set:

- **#1398** — byte/frame ceilings on live sideband websocket frames. Defensive
  bound; no linked user issue.
- **#1396** — 64 KiB cap on reset-credit lookup responses before parsing. Same
  class: hardening a parse path against an oversized upstream response.
- **#1010** — per-model cost overlay. A user-facing *feature*, contributed by
  harryzhou2000, not a fix.

None resolves an open user-reported defect: no open issue in `020` names any of
them as its fix. They are hardening and enhancement, and they ship in the next
train, which will be small and fast precisely because this one drains the
backlog.

Against that, the alternative is publishing from a red gate or waiting
indefinitely. `release.ts` would refuse the first, and the second is not a
release.

**Risk accepted and recorded here for the owner:** v2.12.0 ships without
#1398, #1396, and #1010. If the owner would rather hold the train for those,
the correct sequence is to freeze `dev` merges, let one head go green, and
re-run this work-phase against that head — the rest of the runbook is
unchanged.

## Verification of the chosen RC

```
$ gh run list --commit dc4dd45b04b2564a207b72f9c761a93e631b5299
Cross-platform CI       success   31352564082
Enforce PR target       success   31353241031
PR hygiene              success   31353240929
PR Labeler              success   31353240939
```

Per-job (independently confirmed during the round-1 audit): all four Linux
shards passed; the macOS suite reported `10526 pass / 7 skip / 0 fail`; the
Windows full shards were skipped by the runner-selection job, while the
separate Windows keyring and npm-global smoke jobs passed. Local gates on the
same tree: `bun run typecheck` exit 0, `bun run test` 10,526 pass / 0 fail,
`bun run privacy:scan` passed.
