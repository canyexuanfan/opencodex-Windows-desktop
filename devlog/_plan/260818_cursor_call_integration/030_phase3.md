# 030 — WP4: the stacked pull requests against dev

Rewritten four times. `r1` F4 killed a fabricated split. `r3` F3 found the honest
layering. `r4` F2 found the commit-range version unconstructible. `r5` then found
the ownership version's PROCEDURE unexecutable: it placed commits on a branch before
creating it, never restacked PR2/PR3, claimed a retarget could neutralize a commit
that already exists, and missed two late doc edits.

The lesson across all four: **do not try to re-slice a finished linear history.**
Every attempt produced a procedure that had to move commits between layers, and each
one broke differently. Build the stack FORWARD instead.

## The stack, built forward from the rebase

The rebase produces one linear history `EXPECTED_DEV..cursor-call`. Rather than
cutting that history into layers after the fact, create each layer's branch as a
FRESH commit series whose tree is the layer's contribution:

| PR | Head branch | Base | Owns (subsystem) |
|----|-------------|------|------------------|
| 1 | `cursor-call-wire` | `EXPECTED_DEV` | Cursor wire + WP2b: `cursor-errors.ts`, `live-transport.ts` (EOF resolution + `emittedTerminal`), `native-exec.ts`, `protobuf-request.ts`, `protobuf-events.ts`, `request-builder.ts`, tests `cursor-eof-terminal`, `cursor-request-builder`, `cursor-tool-result-image`, `cursor-interaction-query` (only if WP2b's re-export touches it), decode docs 000-030 |
| 2 | `cursor-call-cancel` | `cursor-call-wire` | Unexpected CANCEL: `cursor-errors.ts` (+`CursorUnexpectedCancelError`), `live-transport.ts` (`classifyTurnFailure`), `tests/cursor-cancel-provenance.test.ts`, decode doc 040 |
| 3 | `cursor-call` | `cursor-call-cancel` | Bridge/adapter terminals: `bridge.ts`, `truncated-stop-reason.ts`, `google.ts`, `anthropic.ts`, `command-code.ts`, their 4 tests, decode doc 050, this integration unit |

`cursor-errors.ts` and `live-transport.ts` appear in PR1 and PR2 on purpose: PR2
edits them again. A file may cross layers; a layer's *contribution* to a file must
not.

The dependency is real: PR2's `classifyTurnFailure` reads PR1's `emittedTerminal`
(absent at `dfb6fb884`, present at `6d9744283` — verified), and PR3's bridge terminal
logic is what makes PR1/PR2's adapter error events reportable at all.

## Procedure — forward construction, no commit ever moves

Run after the WP2 rebase and WP2b are on `cursor-call`. `FINAL` = the rebased
`cursor-call` tip. Nothing below rewrites `cursor-call`.

1. **PR1 branch.** Cut from the pinned base and take the layer's final state
   directly from `FINAL` — which is what will actually be reviewed and merged:

       git switch -c cursor-call-wire EXPECTED_DEV
       git checkout FINAL -- src/adapters/cursor/cursor-errors.ts \
         src/adapters/cursor/native-exec.ts \
         src/adapters/cursor/protobuf-request.ts \
         src/adapters/cursor/protobuf-events.ts \
         src/adapters/cursor/request-builder.ts \
         tests/cursor-eof-terminal.test.ts \
         tests/cursor-request-builder.test.ts \
         tests/cursor-tool-result-image.test.ts \
         devlog/_plan/260817_cursor_toolcall_decode/

   `live-transport.ts` is NOT taken wholesale: `FINAL`'s version contains PR2's
   `classifyTurnFailure`. Take the PR1 state of that one file from the rebased
   commit that ends the wire work (the rewritten
   `docs(devlog): record what shipped for 010 and 020, and why 030 did not` — verified
   unique by `git log --format='%s' EXPECTED_DEV..cursor-call | sort | uniq -d`
   returning nothing), then re-apply WP2b's `protobuf-events.ts` hunk if it landed
   after that point.

   Then `git add` + commit as ONE commit per phase intent, and check the tree:

       git diff --stat EXPECTED_DEV cursor-call-wire

2. **PR2 branch.** Cut from PR1 and take PR2's two files plus its test and doc:

       git switch -c cursor-call-cancel cursor-call-wire
       git checkout FINAL -- src/adapters/cursor/cursor-errors.ts \
         src/adapters/cursor/live-transport.ts \
         tests/cursor-cancel-provenance.test.ts \
         devlog/_plan/260817_cursor_toolcall_decode/040_phase4-server-cancel-terminal.md

   Here `FINAL`'s `live-transport.ts` IS correct — PR2 is the layer that adds
   `classifyTurnFailure`, and nothing above PR2 touches that file.

3. **PR3.** `cursor-call` itself, unchanged. Its diff against
   `cursor-call-cancel` must be exactly the bridge/adapter set plus docs:

       git diff --name-only cursor-call-cancel cursor-call

4. **Prove the partition.** Every changed path must appear in exactly the layer that
   owns its contribution, and the union must equal the whole:

       git diff --name-only EXPECTED_DEV cursor-call-wire
       git diff --name-only cursor-call-wire cursor-call-cancel
       git diff --name-only cursor-call-cancel cursor-call
       # and the decisive one:
       git diff EXPECTED_DEV cursor-call --stat      # equals the union above

   **The load-bearing check:** `git diff cursor-call-cancel cursor-call` must show no
   `src/adapters/cursor/` path other than what PR3 legitimately owns (none). If it
   shows `request-builder.ts` or a cursor test, PR1's checkout in step 1 missed a
   late edit — the exact defect `r5` caught, now caught mechanically instead of by
   reading.

5. **Late doc edits are handled automatically** by step 1 taking the whole
   `devlog/_plan/260817_cursor_toolcall_decode/` directory from `FINAL`. `r5` was
   right that `000_index.md` and `020_*.md` were edited late (by `be1b881ec`); taking
   the final state of the directory rather than a mid-history state is what makes
   that a non-issue.

Because each branch's tree is copied from `FINAL`, **PR1 ∪ PR2 ∪ PR3 is identical to
the rebased `cursor-call` by construction.** That is the property the previous
procedures kept failing to guarantee.

### Commit messages on the rebuilt layers

Each layer's commits are new objects, so the campaign's original messages must be
carried over deliberately — they are the audit trail the devlog cites. Write one
commit per original phase intent with its original message body, and note in the PR
body that the layer is a re-slice of `cursor-call` for review purposes and the
canonical history is `cursor-call` itself.

## Policy constraints (`AGENTS.md`)

- `dev` is the only integration target. Never `main`.
- Stacked children targeting an OPEN parent's head branch are intentional;
  `enforce-target` skips the wrong-base gate for them (`AGENTS.md:218-225`).
  Retarget each child to `dev` after its parent lands.
- `.github/PULL_REQUEST_TEMPLATE.md` requires **Summary**, **Verification**,
  **Checklist**; `enforce-target` rejects thin descriptions.
- Each layer carries its OWN verification evidence (`AGENTS.md:178-180`), per `020`.

## Description content

- **Summary** — the defect and the wire behavior before/after. Two mandatory honest
  notes: (a) in PR1, that dev independently fixed the clean-EOF defect and our
  surviving contribution is `emittedTerminal`, one guard, and WP2b's usage fix;
  (b) wherever tool-result images appear, that the ENCODER supports them and
  production does not reach it because all Cursor models are in `noVisionModels`.
- **Verification** — that layer's own commands, output, and SHA.
- **Checklist** — three boxes, honestly, `docs-site/` determination made here.
- No `Closes #`.

## Fallback (state it, do not hide it)

If step 4's union check fails and the cause is not a missed file but a genuine
interleaving that forward construction cannot express, open ONE PR from
`cursor-call` to `dev` and say why in the body. A single honest PR beats three PRs
whose union is not the branch. Do not iterate on the split a fifth time.

## Verification (C)

```
gh pr list --state open --json number,baseRefName,headRefName,title
gh pr view <n> --json body
```

PR1 base `dev`; PR2 base `cursor-call-wire`; PR3 base `cursor-call-cancel`; step 4's
union check recorded; all three template sections non-thin in each.

