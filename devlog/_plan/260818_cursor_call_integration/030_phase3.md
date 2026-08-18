# 030 — WP4: the stacked pull requests against dev

Rewritten twice. Audit `r1` F4 killed the first version (a fabricated
adapter/bridge/docs split needing cherry-picks). Audit `r3` F3 then showed the
second version was over-corrected: an **honest** stack does exist at the campaign's
own phase boundaries, with no reordering at all. The user asked for a stacked PR, and
it turns out the history supports one.

## The stack (verified against the real topology)

`git log --oneline --reverse <base>..cursor-call` splits at existing commits:

| PR | Head | Base | Range | Commits | Files |
|----|------|------|-------|---------|-------|
| 1 | `cursor-call-wire` | `dev` | `<base>..dfb6fb884` | 17 | `cursor-errors.ts`, `live-transport.ts`, `native-exec.ts`, `protobuf-request.ts`, `request-builder.ts`, 3 cursor tests, 8 decode docs |
| 2 | `cursor-call-cancel` | PR1 head | `dfb6fb884..6d9744283` | 3 | `cursor-errors.ts`, `live-transport.ts`, `cursor-cancel-provenance.test.ts`, `040_*.md` |
| 3 | `cursor-call` | PR2 head | `6d9744283..HEAD` | 15 + WP2b | `bridge.ts`, `truncated-stop-reason.ts`, `google.ts`, `anthropic.ts`, `command-code.ts`, 4 tests, integration docs |

The layering is not cosmetic: PR2's `CursorUnexpectedCancelError` guard reads the
`emittedTerminal` flag PR1 introduces, and PR3's bridge terminal logic is what makes
PR1's and PR2's adapter-level error events reportable instead of silently dropped.

WP2b (EOF usage) belongs in **PR1**, because it modifies `finalizeTurnEvents` — the
function PR1's EOF resolution selects. Land it during the rebase as part of that
layer rather than appending it to PR3.

## Policy constraints (`AGENTS.md`)

- `dev` is the only integration target. Never `main`.
- Stacked children targeting an OPEN parent's head branch are an intentional
  workflow; `enforce-target` skips the wrong-base gate for them
  (`AGENTS.md:218-225`). Retarget each child to `dev` after its parent lands.
- `.github/PULL_REQUEST_TEMPLATE.md` requires **Summary**, **Verification**,
  **Checklist**. `enforce-target` rejects empty, thin, or malformed descriptions.
- Each layer carries its OWN verification evidence (`AGENTS.md:178-180`), per the
  table in `020`. Reusing the tip's evidence for all three is what `r3` flagged.

## Description content

- **Summary** — the defect and the wire behavior before/after, per commit run. Two
  honest notes are mandatory: (a) in PR1, that dev independently fixed the clean-EOF
  defect and our surviving contribution there is `emittedTerminal` plus one guard;
  (b) wherever tool-result images are mentioned, that the ENCODER supports them and
  production does not reach it because all Cursor models are in `noVisionModels` —
  a follow-up, not a shipped capability.
- **Verification** — that layer's commands and output with its SHA. No remembered
  passes, no borrowing the tip's run.
- **Checklist** — three boxes, honestly. "Docs or release notes were updated when
  needed" requires the `docs-site/` determination to be MADE here, not deferred.
- No `Closes #`.

## Verification (C)

```
gh pr list --state open --json number,baseRefName,headRefName,title
gh pr view <n> --json body
```

PR1 base `dev`; PR2 base PR1 head; PR3 base PR2 head; all three template sections
present and non-thin in each.

