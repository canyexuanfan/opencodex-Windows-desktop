# 030 — WP4: the pull request against dev

Rewritten after audit `r1` finding F4. The earlier draft promised three stacked
PRs; the history does not support that split.

## Why ONE PR, not a stack

The user asked for a stacked PR. The honest answer is that this branch is a single
linear chain whose docs and code interleave:

```
git log --oneline --reverse <base>..cursor-call
```

Ten devlog commits come before the first code commit, then documentation lands
after each implementation phase (`dfb6fb884`, `6d9744283`, `3f5bf955d`,
`f10108315`, `fe2237038`, `66b9df9ef`). A "PR1 = adapter, PR2 = bridge, PR3 =
docs" split needs reordering or cherry-picking, so the resulting branches would not
be this history — and `AGENTS.md:178-180` would then require verifying each layer
at its own SHA, tripling the ~8-minute suite for a split that reviews worse.

So: one PR, `cursor-call` → `dev`, with the phase structure explained in the body
(each phase is a contiguous commit run, which is what a reviewer actually needs to
read it phase by phase). If the user still wants separate PRs after seeing this,
that is a rebuild-the-history decision to make deliberately, not a thing to fake.

## Policy constraints (`AGENTS.md`)

- `dev` is the only integration target. Never `main`.
- `.github/PULL_REQUEST_TEMPLATE.md` requires **Summary**, **Verification**,
  **Checklist**. `enforce-target` rejects empty, thin, or malformed descriptions.
- CI status is not checked (user waived) — see `040` for how that is recorded.

## Description content

- **Summary** — per phase: the defect, the wire behavior before and after. Must
  include two honest notes: (a) dev independently fixed the clean-EOF defect, so
  our contribution on `live-transport.ts` narrowed to `emittedTerminal` plus one
  guard; (b) the tool-result image encoder is correct but currently unreachable in
  production because all Cursor models are in `noVisionModels` — named as a
  follow-up, not claimed as a shipped capability.
- **Verification** — the exact lidge commands from `020` with output and SHA. No
  remembered passes.
- **Checklist** — three boxes, each honestly. "Docs or release notes were updated
  when needed" requires the `docs-site/` determination to be MADE first (F5), not
  deferred to `050`.
- No `Closes #`: no issue is being closed.

## Verification (C)

```
gh pr list --state open --json number,baseRefName,headRefName,title
gh pr view <n> --json body
```

Base must be `dev`; all three template sections present and non-thin.

