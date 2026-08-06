# 060 — Phase 7: GitHub Copilot Responses normalization (#1110, PR #1111)

Credit: **Simon** (`Simon <simonbarbier98@gmail.com>`), PR #1111 and issue
#1110. Adoption: **adapted** — the provider fix is kept, one unrelated commit
is dropped.

## Defect (verified on `dev` = e9d957bf6)

The `github-copilot` provider entry (`src/providers/registry.ts:2043`) declares
`adapter: "openai-chat"` but pins every inbound wire to Responses through
`modelWireDefaults` (`:2060`) — its models reject `/chat/completions` for real
Codex-agent traffic. So Copilot responses reach the Responses relay, which
composes only the generic image/id/snapshot repairs. No Copilot-specific
normalization exists, and Codex clients receive Copilot's dialect: non-canonical
ids, provider-only encrypted/obfuscation fields, and tool-call frames that never
form a valid Responses lifecycle.

## Why adapted

#1111's provider repair is sound: it keeps raw upstream frames for inspection
and continuation while normalizing only the Codex-facing relay. The single
merge conflict against `dev` comes from commit `6247d3932`, which edits an
unrelated CI permission assertion (now `tests/ci-workflows.test.ts:4399`).
Dropping that one commit removes the conflict without touching the fix.

## Change

P re-reads `gh pr diff 1111` and adopts the contributor's actual module and test
paths rather than inventing parallel ones — the file list below is confirmed
against the PR at P before any edit, and the module name is taken from the PR,
not chosen here.

| Path | Op | Content |
|------|----|---------|
| The Copilot normalizer module introduced by #1111 (exact path taken from `gh pr diff 1111`) | ADOPT | Provider-scoped client-facing block rewrite: stable response/item ids, strip Copilot-only encrypted/obfuscation fields, buffer tool input until the authoritative function/custom `.done` payload, then emit canonical lifecycle blocks |
| `src/server/responses/core.ts` | MODIFY | Compose the Copilot rewrite with the existing generic rewrites at the relay rewrite composition point (located by symbol — phases 050/070/130 also edit this file), on both the eager and tee paths, under the existing translator budget |
| #1111's Copilot test files (exact paths from the PR diff) | ADOPT | Provider-dialect fixtures: id normalization, field stripping, tool-call reconstruction, byte-preservation of the inspection path |
| `tests/ci-workflows.test.ts` | UNTOUCHED | The conflicting commit `6247d3932` is dropped; this file must show no diff in the phase |

Raw upstream frames stay untouched for diagnostics and continuation — the
rewrite is client-facing only. That boundary is what keeps request-log fidelity
intact.

## Execution

Cherry-pick the PR's commits except `6247d3932`, resolving against current
`dev`. If the range does not apply cleanly, reimplement the module from the
contributor's design and keep the `Co-authored-by: Simon` trailer.

## Verification

- `bun test tests/github-copilot-*.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

Live Copilot traffic is not available in this environment; the tests are
fixture-driven and the PR says so instead of claiming live verification.

## PR

Stack 06, base = stack 05 head. `Closes #1110`. Credits Simon and names the
dropped CI commit explicitly.
