# 010 — R1: rebase the mega-file split stack

Work-phase: wp2. Scope: **review + rebase + push. No merges.**

## Why the CI is red, precisely

`#2019` shows four red test shards. None of them is a defect in the change.

The failing assertion in shard 2/4 looks for the literal string
`invalidateCodexModelsCacheWithPermit(permit, owningCodexHome)`. That string
exists on the PR head (three files: `src/cli/dispatch.ts`,
`src/codex/catalog/sync.ts`, `tests/codex-app-server-processes.test.ts`) and
does not exist anywhere on `dev` — `6c0bde453` removed it.

GitHub merges the PR head with the base before running CI. So the run
executed **dev's newer test file against the PR's older source**. The other
three shards fail the same shape (hidden raw reasoning, Command Code catalog,
GUI models page).

The control that proves it: `#2023` is a strict superset of `#2019`'s changes,
and on its own base it is **fully green** — 4/4 test shards, gates, macos,
every keyring and npm-global leg. A defect in the extraction would fail there
too.

## Verified rebase cost

A scratch rebase of `codex/split-wp1b-type-clusters` onto `origin/dev`
(102 commits) conflicts in exactly one file, `src/types.ts`, with **3 hunks**.

Three dev commits touched `src/types.ts` since the fork point (`b04cd26e7`):

| Commit | Change |
|---|---|
| `11e03eb44` | replay: durable thought signatures per credential (#2078) |
| `fd85c8238` | cursor: HTTP/1.1 compatibility transport (#1903) |
| `b5a98d690` | release-audit regressions from the 260818 merge train |

All three add or modify type declarations. Because WP1b turns `types.ts` into
a pure barrel, each conflict resolves the same way: **the new declaration moves
to the leaf that owns its cluster, and the barrel gains a re-export line.**
This is mechanical, but it is not automatic — resolving it by taking "ours"
would silently drop three landed changes.

## Order

`#2019` and `#2036` are independent; `#2023` is a child of `#2019`.

1. Rebase `codex/split-wp1-types` onto `origin/dev`; resolve `types.ts`;
   force-push. Confirm the four shards go green.
2. Rebase `codex/split-wp1b-type-clusters` onto the NEW `#2019` head, not onto
   dev. Rebasing it onto dev directly would orphan the parent PR's diff.
3. Rebase `codex/split-wp2a-config-names` onto `origin/dev` (42 behind, already
   green — this is upkeep, not a fix).

All three branches are ours (`lidge-jun`), so force-push is in scope.

## The hygiene failure is real and is not fixed by rebasing

All three PRs fail `hygiene: missing_regression_test`: they change `src/`
without changing a test. That gate is correct here — and the honest answer is
`test-exception-approved`, not a manufactured test.

A pure-move PR's oracle is the ~400 test files that import through the barrel
plus `tsc --noEmit`. A new test asserting "the barrel re-exports `OcxTool`"
restates what the compiler already proves and would pass even if the extraction
were wrong in every way that matters.

Verified: dev's `src/types.ts` exports 85 names; the WP1b barrel re-exports all
85 across six leaves (`tools`, `wire`, `request`, `config`, `provider`,
`accounts`), reducing 1884 lines to 103.

## Exit criteria

- `c-2019`: new head pushed; the four previously-red shards no longer FAILURE.
- `c-2023`: rebased onto the new parent head; base ancestry correct.
- `c-2036`: rebased onto dev; still green.
- No merges. No `src/` change beyond conflict resolution.
