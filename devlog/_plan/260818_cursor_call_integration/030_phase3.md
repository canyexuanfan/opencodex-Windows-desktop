# 030 — WP4: stacked PRs targeting dev

## Policy constraints (`AGENTS.md`)

- `dev` is the only integration target. Never open a feature PR against `main`.
- `.github/PULL_REQUEST_TEMPLATE.md` has three required sections: **Summary**,
  **Verification**, **Checklist**. `enforce-target` rejects empty, thin, or
  malformed descriptions.
- Stacked child PRs that target another OPEN PR's head branch are an intentional
  workflow; `enforce-target` skips the wrong-base gate for them. Retarget children
  to `dev` after the parent lands.
- CI status is NOT checked (user waived).

## Stack shape

The campaign is one dependency chain, and the branch is one linear history. The
honest stack boundary is by SUBSYSTEM, because that is what a reviewer can review
independently:

| PR | Head branch | Base | Content |
|----|-------------|------|---------|
| 1 | `cursor-call-adapter` | `dev` | Cursor adapter: image tool results, cancel provenance, `emittedTerminal` (`878b067e8`..`c9681d043` + the resolved `54f68daf5`) |
| 2 | `cursor-call-bridge` | `cursor-call-adapter` | Bridge terminal/compaction work (`aa800ae65`..`1651002c5`) + `src/responses/truncated-stop-reason.ts` |
| 3 | `cursor-call` | `cursor-call-bridge` | devlog units (both decode and integration) |

Splitting is only worth doing if the split points are clean commit boundaries in
the rebased history. If the rebase produced interleaved docs/code commits, prefer
ONE PR from `cursor-call` → `dev` over a fake stack: an unreviewable split is
worse than a single honest PR. Decide from the actual topology at WP4's P.

## Description content per PR

- **Summary** — the defect, the wire behavior before/after, and for PR 1 an
  explicit note that dev independently fixed the clean-EOF defect and our
  contribution on that file narrowed to `emittedTerminal` + the extra guard.
- **Verification** — the exact lidge commands from `020` with their output and the
  SHA. No remembered passes.
- **Checklist** — all three boxes, honestly.
- No `Closes #`: no issue is being closed by this branch.

## Verification (C)

```
gh pr list --state open --json number,baseRefName,headRefName,title
gh pr view <n> --json body   # confirm all three template sections present
```

