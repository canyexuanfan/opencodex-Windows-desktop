# 060 — Stage Windows back into CI as a real gate (F3)

**Depends on:** 010-051. Arming the gate before the known defects are fixed just
turns the gate red.

## Change

Staged, because flipping `if: github.event_name == 'workflow_dispatch'` in one
step is how a gate gets disabled again a week later.

**Stage 1 — run it, do not gate on it.** Let `platform-windows` run on
`pull_request` and `push` with `continue-on-error: true`. Collect real data on
duration and failure rate across at least a week of normal merges. Nothing
blocks.

**Stage 2 — resize the shards.** The current matrix is 4 shards over ~806 files,
roughly 200 files each. The 806/806 result was achieved in batches of ~60 files
because Bun 1.3.14 panics near 3.5GB RSS on larger runs, and CI-shaped shards
have reproduced that panic. Move to a shard size near the batch size that
actually worked. This is a prerequisite for gating, not an optimization: a gate
that fails on a runtime panic rather than a test failure teaches maintainers to
ignore it.

**Stage 3 — gate on `pull_request`.** Remove `continue-on-error`. Windows now
blocks merges to `dev`.

**Stage 4 — close the release hole.** `.github/workflows/ci.yml:747-783` accepts
`skipped` for every job. Once Windows runs on push, that tolerance must not
apply to it: assert `platform-windows` reached `success`, not
`success || skipped`. Otherwise `release.yml:181-201` keeps accepting a
push-event run in which Windows silently did nothing — which is the current
state described in `000`.

Runner choice: hosted `windows-latest` for the gate. The self-hosted path
(`select-windows-runner`, `ci.yml:85`, repo variable `OCX_SELF_HOSTED_WINDOWS`)
stays what its own comment says it is — an operational switch, not a security
boundary — and a persistent runner carries state between runs, which is the
opposite of what a trustworthy gate needs.

## Verify

```powershell
gh workflow run ci.yml --ref <branch>
```

Each stage is verified by its own run history, not by the next stage.

## Risk

High if rushed, low if staged. The failure mode is a red gate everyone learns to
override. Stage 1's data is what tells us whether stage 3 is safe.
