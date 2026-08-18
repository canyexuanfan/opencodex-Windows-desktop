# 018 — Audit round r14: three defects found by RUNNING the plan

`r14` did what `r13` started: it executed every shell fragment in the unit against a
scratch zsh with real SHAs substituted, simulating only the mutating commands. Three
High findings, all closed.

## F1 — the authoritative gates were not bound to the pinned worktree

`020` created `/tmp/ocx-cc-<sha>` on lidge, asserted its HEAD, and then listed the
gates as bare local commands:

    bun x tsc --noEmit
    bun run privacy:scan
    ...

Copied into a shell, those run against whatever directory the operator is in. The
phase could report green for a tree that is not `VERIFIED_TIP` — which is the whole
thing `r10` and `r12` were about.

**Closed.** The gates are now a loop that runs each one over ssh inside the worktree
and re-asserts the SHA first:

    ssh lidge "cd $CC_WT && test \"\$(git rev-parse HEAD)\" = \"$VERIFIED_TIP\" && $GATE"

## F2 — the per-layer fragment could not run

Two separate breakages in one block:

1. It used `$PR1_HEAD` and `$PR2_HEAD`, which `030` does not assign until step 4,
   while `020` ordered this section after step 3. A zsh probe with unset-variable
   checking fails outright.
2. `bun test <that layer's files from the table>` is a zsh parse error
   (`unmatched '`), not an instruction. A placeholder inside a code block is a bug.

**Closed.** The section now runs after `030` step 4, spells out `PR1_TESTS` and
`PR2_TESTS` as real variables, and wraps the per-layer work in a `run_layer` function
that pins, asserts, installs, typechecks, and runs that layer's files.

## F3 — the sixth artifact-chain gap: no PR BASE assertion

`040` asserted the live `dev` SHA (has `dev` moved?) and each `headRefOid` (has the
PR head moved?). Neither answers "is this PR still pointing at `dev`". A retarget to
`main`, or to a parent branch that has since merged, passes both — and
`gh pr merge` would merge into that base. `030` printed the bases for inspection,
which is not a gate.

**Closed.** The pre-merge check for every layer is now three assertions together:
`baseRefName == dev`, `headRefOid == EXPECTED_HEAD`, live `dev == EXPECTED_DEV`.

## The artifact-chain sweep r14 ran

| Boundary | Artifact | Binding | Result |
|---|---|---|---|
| WP2 → WP2b | rebased `cursor-call`, `VERIFIED_BASE` | push + remote/local equality | PASS |
| WP2b → WP3 | WP2b's remote tip | `VERIFIED_TIP` from live remote, local equality, worktree HEAD assertion | PASS |
| WP3 → WP4 | gate evidence | branch tips bound to `VERIFIED_TIP` | **FAIL → fixed (F1, F2)** |
| WP4 → WP5 | PR heads + base topology | head + live-`dev` checks | **FAIL → fixed (F3)** |
| WP5 → WP6 | PR3 merge OID as `MERGED_DEV` | worktree at `MERGED_DEV` + HEAD equality | PASS |
| WP6 → note | gate outputs | note requires command, output, SHA, fresh refs | PASS |

## What r14 confirmed

- Stack at the audited tip: unique subjects, zero merges, ancestry intact,
  `17 + 3 + 31 = 51`.
- Both `010` conflict resolutions still coherent against the live `dev`.
- `015`'s failure-specific usage choice, re-export, and no-cycle property.
- `040`'s governance position claims an owner-authorized exception, not compliance.
- It also ran the focused Cursor tests: **71 pass, 0 fail**, and typecheck exit 0.

## Tally

Fourteen rounds, 38 findings, every one verified and absorbed. Six of them are the
artifact-chain class (`r7`, `r8`, `r10`, `r12`, `r13`, `r14`) and four were the
stack-split cluster (`r3`-`r6`). The lesson `r13` and `r14` add: a plan that is only
READ will keep hiding fragments that cannot RUN.

