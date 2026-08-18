# 018 — Audit round r14-20260818043616: FAIL, and the last placeholders die

`r14` audited by RUNNING the plan rather than reading it: a `zsh -n` matrix over
every snippet plus the read-only extractions. Six of nine named artifacts failed.

## What it found

1. **`VERIFIED_BASE` was captured twice.** `010:166` pins it before the rebase;
   `020` captured it AGAIN afterwards. A second `ls-remote` overwrites the pin with a
   newer `dev`, and every later assertion then compares against a base the campaign
   never rebased onto.

2. **`git branch cursor-call-wire <PR1_TIP>` fails `zsh -n`.** The angle-bracket form
   is not shell syntax. `030` captured `PR1_TIP`/`PR2_TIP` correctly and then did not
   consume them.

3. **`040` carried THREE merge procedures** that disagreed. One used `$PRN`,
   `$PRN_HEAD` and `$PR_NEXT` — none of which any phase assigns. One omitted the head
   assertion and the `EXPECTED_DEV` update entirely. `r14` noted the angle-bracket
   forms in `040` parse only because zsh reads them as redirections, which is worse
   than failing: they run and bind nothing.

## The fix

- `020` inherits `VERIFIED_BASE` and asserts it instead of re-capturing:
  `test -n` plus `git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call`.
- `030` step 2 uses `git branch cursor-call-wire "$PR1_TIP"`, and step 1's
  `git show --stat` calls consume the variables too.
- `040` now has ONE merge ladder, a `merge_layer` function taking the PR number and
  its expected head, asserting base + head + `EXPECTED_DEV` before merging and
  advancing `EXPECTED_DEV` from the merge commit inside the function. The two
  half-procedures above it are gone; those sections state the invariant only.

Verified by running the whole chain under zsh: parses clean, and the extractions
return `dfb6fb884…` and `6d974428…` — exactly the two boundary commits `030` names.

## Side effect worth recording

The reviewer executed one `020` scratch snippet during isolation and left a worktree
`/tmp/ocx-L-` plus branch `ocx-L-` on lidge. Removed (`git worktree remove --force`,
`git branch -D`); lidge is back to 13 worktrees and nothing was pushed or edited
there. Worth noting that a READ-ONLY audit brief still produced remote state — the
snippets are executable now, which is the point, and an auditor running them is a
foreseeable consequence.

## Six rounds, one lesson

`r7`, `r8`, `r10`, `r13`, the `r13` confirmation, and now `r14` all found the same
thing at different altitudes: a binding that reads correctly and enforces nothing.
The difference in `r14` is method — it ran the text instead of reading it, and found
six instances where thirteen rounds of reading had found none.

