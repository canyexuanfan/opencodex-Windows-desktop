# 019 — The plan becomes a program

Fifteen audit rounds. Six of them (`r7`, `r8`, `r10`, `r12`, `r13`, `r14`, `r15`)
found the same defect class at different altitudes: a binding written as prose that
no shell would enforce. Each round I fixed the instances it named, and the next round
found new ones — `VERIFIED_BASE` captured twice, `git branch cursor-call-wire
<PR1_TIP>` failing `zsh -n`, three contradictory merge ladders, `<pr3>` that zsh
reads as a redirection, `PR1_TIP` consumed at line 88 and assigned at line 94, PR
numbers referenced but never assigned anywhere.

Seven rounds of the same failure is not seven mistakes. It is one wrong idea:
**I was trying to make a document behave like a program.**

A markdown file cannot enforce that a variable is assigned before it is read. It
cannot fail. Every fix I wrote was a promise that the next reader would execute the
fragments in the right order with the right values in scope — and every audit proved
that promise false, because the promise is unenforceable by construction.

## What changed

`cursor-call-integration.zsh` in this directory is now the executable form of
`010`/`020`/`030`/`040`/`050`. The decade docs keep their job — the EVIDENCE and the
REASONING for each decision, which is what a reviewer needs and what a script cannot
carry. The script owns what runs.

Properties the prose could never have:

- **`set -euo pipefail`** — an unset variable is a hard error, not a silent empty
  string. The entire class of finding that consumed seven rounds is now impossible.
- **State on disk** (`.tmp/cursor-call-integration.env`, gitignored). Each step reads
  what earlier steps recorded, so a compaction or a disconnect costs nothing, and
  `need VERIFIED_TIP` fails loudly instead of proceeding with an empty value.
- **Every assertion is a `test` or an `||die`.** There is no printed value for an
  operator to eyeball.
- **Idempotent steps** — `git branch -f`, `worktree add ... || true`, and
  `EXPECTED_DEV` re-derived from state on each run.
- **Nothing merges or pushes implicitly.** The operator names the step.

## Verified, not asserted

    zsh -n cursor-call-integration.zsh          -> PARSE_OK
    zsh cursor-call-integration.zsh state       -> "no state yet"
    zsh cursor-call-integration.zsh pin         -> recorded VERIFIED_BASE=1645bb924…
    zsh cursor-call-integration.zsh state       -> the value persisted
    zsh cursor-call-integration.zsh cut         -> FATAL: VERIFIED_TIP is not set (exit 1)
    zsh cursor-call-integration.zsh merge       -> FATAL: VERIFIED_TIP is not set (exit 1)
    zsh cursor-call-integration.zsh release_gates -> FATAL: MERGED_DEV is not set (exit 1)
    zsh cursor-call-integration.zsh record_prs 1 2 -> FATAL: usage (exit 1)
    zsh cursor-call-integration.zsh bogus       -> FATAL: unknown step (exit 1)

Those failures are the point: the ordering the prose could only request, the script
enforces.

## Step map

| Step | Doc | What it does |
|------|-----|--------------|
| `pin` | `010` | `VERIFIED_BASE` from live `ls-remote`, recorded |
| `rebase` | `010` | rebase onto it, assert ancestry, refuse conflict markers |
| `push` | `010`/`015` | `--force-with-lease`, assert remote == local |
| `verify` | `020` | `VERIFIED_TIP`, lidge worktree at that SHA, five gates each re-asserting HEAD |
| `cut` | `030` | boundaries by subject, three ancestry assertions, count partition, push branches |
| `verify_layers` | `020`/`030` | push the two layer branches, then typecheck + that layer's own tests AT ITS OWN HEAD |
| `record_prs` | `030` | operator records the three PR numbers after `gh pr create` |
| `merge` | `040` | per layer: base==dev, head==expected, live dev==EXPECTED_DEV, then merge and advance from the merge commit |
| `release_gates` | `050` | `MERGED_DEV` worktree on lidge, five gates |
| `release_state` | `050` | live main/dev/tags/dist-tags/releases for the readiness note |
| `cleanup` | `020`/`050` | remove the verification worktrees both phases require removing |

## What round 15 found in the FIRST version of this script

Writing the program did not make the program correct — it made its defects findable.
The audit ran it and found seven, three of them fatal:

- **`LIDGE_HOME=~/Developer/opencodex` expanded LOCALLY.** zsh resolved `~` to
  `/Users/jun`, so every ssh command sent a macOS path to a Linux host. The remote
  gates could not have run at all. Now single-quoted `'$HOME/Developer/opencodex'`,
  expanded by the remote shell.
- **`merge` could not resume.** It restarted at PR1 every time, so a disconnect
  between `gh pr merge` and `save` would re-attempt a merged PR. `merge_layer` now
  reads the PR state first: `MERGED` adopts its merge commit and returns, `OPEN`
  proceeds, anything else is fatal.
- **Layers were never verified at their own heads**, which `AGENTS.md:178-180`
  requires. `cut` pushed and moved on. That work is now `verify_layers`, and
  `merge` refuses without `LAYERS_GREEN_AT`.

And four smaller ones: `|| true` on worktree creation swallowed real failures and
accepted a dirty tree at the right HEAD; neither worktree was ever removed; the
conflict scan missed a lone `=======`; `push`/`verify` did not require
`VERIFIED_BASE`; re-running `pin` silently invalidated every downstream artifact;
and the state file was `source`d without validating what went into it.

Three more I found by running it myself: `save` appended instead of replacing,
`ROOT` counted `..` wrong and wrote state to `devlog/.tmp/`, and two steps never
called `load_state`.

Ten defects in a 200-line script, none of which fifteen rounds of reading prose had
surfaced. That is the case for the rewrite, and also the case for not trusting the
rewrite until it has been run.

`record_prs` is deliberately manual: PR numbers do not exist until `gh pr create`
returns them, and inventing a way to guess them would reintroduce exactly the
unbound-value problem this file exists to end.

## What the docs still own

The script says what runs. It does not say why dev's error-event EOF shape beat ours,
why WP2b must use `partialUsageFromEventState` rather than `resolvedTurnUsage`, why
the stack splits where it does, or why the merge is an owner-authorized exception
rather than policy compliance. Those live in `010`, `015`, `030` and `040`, and a
reviewer needs them more than they need the commands.
