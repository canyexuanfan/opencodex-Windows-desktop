# 070 — wp2: #2427, parallel test runner (last, or deferred)

Phase: wp2 — runs **last**, immediately before freeze. PR: #2427, head
`eb7b101a9`, author `olddonkey`.

> This phase was originally planned first. The A-phase audit argued it should be
> last and won; see 000 §"Why #2427 moved to the end". The decade number keeps
> its original identity while the dependency order in 000 governs execution.

## What it changes

`scripts/test.ts` — MODIFY. The default child invocation moves from

```
bun test --isolate ./tests/
```

to

```
bun test --isolate --parallel ./tests/
```

with argv handling (`:62-141`) that preserves a caller-supplied `--parallel`,
consumes separated option values for `--timings` / `-c` / `--config` so they are
not mistaken for file filters, and respects the `--` delimiter.
`bunfig.toml:8` documents that file-level parallelism comes from the script.
`tests/test-runner.test.ts:79-163` covers the resolver plus a real subprocess
fixture.

The wiring is genuine — `scripts/test.ts:251-259` spawns through
`resolveBunTestArgs`, not merely a helper.

## Why it is last and conditional

The PR's own body reports **7 failures across 902 files** on its exact head,
and simultaneously has all four readiness boxes ticked including "All CI tests
are green on my local testing." Those two statements cannot both be true. The
branch is also 6 commits behind `dev` (merge-base `35a89903c`).

Beyond the metadata contradiction there is a structural argument: parallel
execution raises shared-state contention, so landing it *before* the runtime
fixes would make every later failure ambiguous between "this PR broke it" and
"the new runner is flaky." A verification instrument gets changed against a
known-good baseline; it does not get used to establish one.

## Required sequence

1. Rebase onto `dev` at the post-wp1 head.
2. Let the readiness checklist reset (the gate does this on push) and have it
   re-ticked truthfully.
3. Run `bun run test` at the exact rebased head. Record exit code and the
   failure list if non-zero.
4. If exit 0 and cross-platform CI is green: merge, then re-run the wp3–wp7
   focused verifiers under the new runner to confirm the instrument change did
   not alter their outcome.
5. If not: **defer**, record the evidence, and freeze on the existing runner.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Branch rebased onto post-wp1 `dev` | `git merge-base` == dev head |
| 2 | PR body no longer self-contradicts | PR body diff |
| 3 | `bun run test` exit 0 at exact head | captured output |
| 4 | Cross-platform CI green at that SHA | `gh pr checks` |
| 5 | Post-merge: wp3–wp7 focused verifiers still green | captured output |
| 6 | Merged **or** deferred with evidence | merge SHA or defer record |

## Scope boundary

IN: `scripts/test.ts`, `bunfig.toml`, `tests/test-runner.test.ts`.
OUT: #2429 (`test:changed`), which is stacked on this PR and belongs to the next
minor.

