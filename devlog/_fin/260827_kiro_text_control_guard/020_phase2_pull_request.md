# 020 — Phase 2 (wp3): land the pull request against \`dev\`

Consumes wp2's verified tree. Nothing here starts until wp2's C is green.

## Branch

The session runs in the Codex-app-managed worktree
\`/Users/jun/.codex/worktrees/121f/opencodex\`, which starts detached at
\`9b838d062\`. Adopt in place — never move or recreate the worktree
(WORKTREE-GUARD-01):

    git switch -c codex/kiro-text-control-guard

\`codex/\` is the prefix this app requires.

## Base and ancestry

\`AGENTS.md\`: every pull request targets \`dev\`. \`main\` moves only by maintainer
promotion.

The \`enforce-target\` check rejects a head whose ancestry sits on the \`main\` tip
while far behind \`dev\`. Verified 2026-08-27: \`git merge-base --is-ancestor HEAD
origin/dev\` succeeds at \`9b838d062\`, so the branch is on \`dev\`'s line, not
\`main\`'s. Re-verify after fetching, since \`dev\` moves.

    git fetch origin dev
    git merge-base --is-ancestor HEAD origin/dev && echo on-dev-line

If \`dev\` has advanced materially, rebase before opening — the contributor
readiness checklist requires the branch to be on the latest \`dev\` commit or at
most 10 behind.

## Remote

The worktree has \`csa906\` and \`if2007\` remotes plus \`origin\`. Confirm which one
is the upstream this PR should target before pushing:

    git remote -v
    git config --get branch.dev.remote

Push only the feature branch, never \`--force\` onto a shared ref.

## Pull request body

\`.github/PULL_REQUEST_TEMPLATE.md\` requires **Summary**, **Verification**, and
**Checklist**, all filled. \`enforce-target\` rejects empty, thin, or malformed
descriptions. Read the template from the tree at PR time rather than
reconstructing it here — it may have changed.

Content to supply:

- **Summary** — the guard rejected the presence of any Responses \`text\` member,
  so \`text.verbosity\`, \`text.format: {"type":"text"}\`, and \`text: {}\` produced
  HTTP 400 \`invalid_request_error\` on \`kiro/*\` turns while the identical request
  without \`text\` succeeded. Narrowed to \`_structuredOutput\`, which the parser
  already sets for \`json_schema\`/\`json_object\` only. Structured output stays
  refused. Cite the \`sendCount: 0\` evidence and name \`db040e70f\` as the sibling
  fix in the same function.
- **Verification** — pasted tails with exit codes for
  \`bun test tests/kiro-adapter.test.ts\`, \`bun x tsc --noEmit\`, and
  \`bun run test\`, plus the activation evidence: the new tests failing against
  the pre-fix guard and passing after.
- **Checklist** — every box ticked truthfully.

No screenshot is required: the \`gui\` screenshot rule triggers on a title or
description mentioning \`gui\`, and this change touches none.

There is no issue to close, so no \`Closes #n\` line. If one is filed first, add
it — and remember GitHub auto-closes only on merge to \`main\`, while this targets
\`dev\`, so the issue needs a manual close.

## Draft status

If the pushing account lacks repository push permission, \`enforce-target\` opens
the PR as a draft and holds it there until the four-box readiness checklist is
complete: local CI green, branch on the latest \`dev\`, Codex/CodeRabbit findings
fixed, ready-for-review confirmed. The gate binds completion to the exact head
commit — a later push resets every box. So: push everything first, then tick.

## CI proof at the exact head SHA (criterion c7)

Not "CI passed", but "CI passed **at this SHA**":

    git rev-parse HEAD
    gh pr view --json number,baseRefName,headRefOid,isDraft
    gh pr checks <number>

\`headRefOid\` must equal local \`HEAD\`. A green run on an ancestor is not
evidence for the head. If CI is red, read the failure and return to wp2 rather
than re-running for luck.

## Review expectations

\`AGENTS.md\` review guidelines: English review, name file and line, concrete
failure mode. Automated reviewers (Codex, CodeRabbit) will comment; correct
findings must be fixed before ready-for-review. Likely questions worth
pre-empting in the PR body:

- *Why not strip \`text\` before serialization like \`openai-responses\` does?*
  Because \`buildKiroPayload\` never spreads \`_rawBody\`; there is nothing to
  strip. The test asserts the absence.
- *Does this weaken structured-output refusal?* No — the retained test proves
  both \`json_schema\` and \`json_object\` still throw.
- *Why change the error message?* It named a behavior that no longer exists.
  Leaving "text controls" in the string would misdescribe the guard.

## Close-out (D)

- Move \`devlog/_plan/260827_kiro_text_control_guard/\` to \`devlog/_fin/\` once the
  change is on \`dev\` — \`_fin\` records work already visible in public history.
- Record the terminal outcome honestly. \`DONE\` requires the PR open against
  \`dev\` with CI green at the head SHA. A PR awaiting maintainer merge is still
  \`DONE\` for this goal: merging is not the agent's to do.
- Note the two deferred observations for follow-up units: the repeated Kiro
  OAuth refresh (54 rows) and the Cursor discovery failure dropping 13 model
  ids.

## Approval boundary

The user authorized this PR explicitly ("pr 올려"). That authorization covers
pushing this branch and opening this pull request. It does not extend to
merging, releasing, publishing, or force-pushing any shared ref
(DEV-GIT-PUSH-01).

