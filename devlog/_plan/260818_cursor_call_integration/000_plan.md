# 000 — Integrate cursor-call onto dev and reach release-ready state

## Objective

Land the 31-commit `cursor-call` tool-call hardening campaign on the current `dev`
head, then carry it to a release-ready state. The campaign shipped against
`f64c0639` (merge-base); `dev` has moved 104 commits since, and two of the files
we changed were changed there too — one of them for the SAME defect, in the
opposite shape.

This unit is the integration record, not a re-decode. The decode unit is
`devlog/_plan/260817_cursor_toolcall_decode/`.

## Evidence base

| Fact | Command |
|------|---------|
| merge-base = `f64c06391` | `git merge-base origin/dev cursor-call-prerebase-260818` |
| ours = 31 commits, snapshot `cursor-call-prerebase-260818` = `fe2237038` | `git rev-list --count origin/dev..cursor-call` |
| dev head = `87f7f970b`, 104 commits ahead of merge-base | `git rev-list --count cursor-call..origin/dev` |
| our 31 commits touch 18 files | `git diff --name-only <base> cursor-call-prerebase-260818` |
| only 2 of those 18 were touched on dev | per-file `git log --oneline <base>..origin/dev -- <file>` |

## Collision inventory (all 18 files)

`COUNT` is dev commits touching that path since the merge-base.

| File | dev commits | Collision |
|------|-------------|-----------|
| `src/adapters/cursor/live-transport.ts` | 3 (`6a64db19d`, `08eb65d1f`, `1824a0148`) | **SEMANTIC** — same defect, opposite shape |
| `src/adapters/google.ts` | 6 (`aca3c0241`, `0be660a2e`, `f6c88febf`, `812255d3a`, `d62cc4029`, `343e5d7a3`) | **TEXTUAL** — identity/rename work, our hunk drifted 939 → 946 |
| `src/adapters/anthropic.ts` | 0 | none |
| `src/adapters/command-code.ts` | 0 | none |
| `src/adapters/cursor/cursor-errors.ts` | 0 | none |
| `src/adapters/cursor/native-exec.ts` | 0 | none |
| `src/adapters/cursor/protobuf-request.ts` | 0 | none |
| `src/adapters/cursor/request-builder.ts` | 0 | none |
| `src/bridge.ts` | 0 | none |
| `src/responses/truncated-stop-reason.ts` | 0 (absent on dev — we add it) | none |
| `tests/anthropic-error-stop-reason.test.ts` | 0 | none |
| `tests/bridge-nonstreaming-terminal.test.ts` | 0 | none |
| `tests/command-code-error-finish.test.ts` | 0 | none |
| `tests/cursor-cancel-provenance.test.ts` | 0 | none |
| `tests/cursor-eof-terminal.test.ts` | 0 | none (but see 010: its EXPECTATION changes) |
| `tests/cursor-request-builder.test.ts` | 0 | none |
| `tests/cursor-tool-result-image.test.ts` | 0 | none |
| `tests/google-buffered-stop-reason.test.ts` | 0 | none |
| `devlog/_plan/260817_cursor_toolcall_decode/*` | 0 | none |

An INDIRECT-breakage sweep found nothing: `AdapterEvent.done.stopReason?: string`
still exists (`src/types.ts:367-371`), no symbol our bridge patch references was
renamed, and `src/bridge.ts` / `src/responses/truncated-stop-reason.ts` have zero
dev commits.

## Loop-spec

- Loop archetype: verifier-defined (typecheck + full suite on lidge decide done).
- Write scope: the 18 files above plus this unit. No version bump, no npm publish,
  no `main` promotion, no gui/ source changes.
- Tool/credential scope: local git, `ssh lidge` for verification, `gh`/GitHub app
  for PRs and the admin merge. Push to `origin/cursor-call` is pre-approved
  (`--no-verify`); force-push is inherent to the requested rebase and the
  snapshot branch `cursor-call-prerebase-260818` is the recovery path.
- Bounds: no stated token budget. Wall-clock is dominated by the lidge full suite
  (~470s at 12800 tests). CI is explicitly NOT checked (user waived).

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1-integration-roadmap | this unit | conflict inventory + roadmap (docs-only) | — |
| wp2-rebase | `010` | rebase with evidence-based conflict resolution | wp1 |
| wp3-remote-verify | `020` | typecheck + full suite on `ssh lidge` at the pushed SHA | wp2 |
| wp4-stacked-prs | `030` | stacked PRs targeting `dev` with the repo template | wp3 |
| wp5-merge | `040` | admin merge onto `dev` + ancestry proof | wp4 |
| wp6-release-gates | `050` | release gates on `dev` + go/no-go note | wp5 |

## Accept criteria (mirrored into the goalplan)

- `c1-roadmap-unit` — this unit exists with research + diff-level decade docs.
- `c2-conflict-inventory` — the table above, produced by the named commands.
- `c3-rebase-clean` — rebase lands, no conflict markers, dev head is an ancestor.
- `c4-resolution-audited` — every resolution passes an adversarial audit round.
- `c5-remote-green` — typecheck clean + full suite green on lidge at the SHA.
- `c6-prs-open` — stacked PRs against `dev`, template filled.
- `c7-merged-on-dev` — `git merge-base --is-ancestor` proves it, not an API reply.
- `c8-release-gates` — privacy:scan, typecheck, full suite green on merged `dev`.
- `c9-go-no-go` — a written note on whether to cut a version.

## Out of scope (carried follow-ups, NOT this unit)

These were recorded in the decode unit and stay open:

1. Kiro `completionMode: "disabled"` drops `stopReason` (`kiro.ts:1315`, `:1485`).
2. Google ordinary mode still forwards only `MAX_TOKENS` + five safety values;
   `MALFORMED_RESPONSE`, `UNEXPECTED_TOOL_CALL`, `IMAGE_SAFETY`, `LANGUAGE`
   become reasonless `done` (dev `google.ts:786-795`).
3. User-message images still placeholdered in `request-builder.ts`.
4. Phase 030 (xai apply_patch) remains a measurement cycle — NOT REPRODUCED.
   New information: dev landed `bc229433a` + `8a4040384`, which stop the code-mode
   guidance from forbidding a separately-advertised top-level `apply_patch`. That
   is the same affordance surface 030 suspected, fixed independently. Re-probing
   belongs to a later work-phase only if the user supplies a failing case.

