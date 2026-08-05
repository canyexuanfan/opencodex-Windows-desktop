# 030 — WP4: issue ↔ PR cross-links

> Pre-written in WP1. Consumes the closed tables from `010` and `020`.

## What this phase must produce

A matrix resolving every claim of the form "PR #X fixes issue #Y" and every
suspected duplicate pair, with a semantic equivalence basis.

## The rule this phase exists to enforce

From `devlog/_plan/260805_bug_stack_campaign/130_dispositions.md:29-32`: a
superseded verdict requires comparing the landed behavior and tests against the
contributor PR's full scope, preserving authorship where the approach was
adopted, and recording any contributor behavior deliberately not matched.
**"The linked issue is fixed" alone is never sufficient.**

That rule was written after a round where it was nearly violated. It applies here
unchanged.

## Complete reference ledger

Extracted from PR titles and bodies with the untruncated, type-resolved command
in `020`, then each referent resolved through
`gh api repos/lidge-jun/opencodex/issues/<n>` to separate issue from PR and open
from closed. A PR absent from this table asserted no issue link.

| PR | referent | referent type/state | relation |
|---:|---|---|---|
| 1036 | #1017 | ISSUE open | fixes |
| 999 | #241 | ISSUE open | documents-only |
| 1056 | #241 (via title) | ISSUE open | partially-fixes |
| 1010 | #1009 | ISSUE closed | closes-already-closed |
| 1039 | #914 | ISSUE closed | descendant-of |
| 1039 | #922, #1023, #1025, #1026 | PR | descendant-of |
| 1019 | #671, #949 | PR | continuation-of |
| 1018 | #1016 | PR merged | rebase-provenance |
| 936 | #253 | ISSUE closed | motivating-report |
| 936 | #899, #916, #917 | PR | rebase-of (#916); explicitly not superseded-by (#917) |
| 557 | #533 | PR | supersedes |
| 937, 872, 870, 812 | #572 | ISSUE open | sibling-of-batch |
| 947 | #942 | PR closed | conflicts-with |
| 1047, 1002 | #1024 | ISSUE open | overlap-to-check |

Two referents the first pass missed, both recovered by dropping the `.[0:3]`
truncation: **#914** (from #1039 — closed issue, DNS/network reachability
rotating Codex accounts) and **#253** (from #936 — closed issue, subscription-mode
`ocx claude` losing authentication). Both are closed, so neither changes a
disposition; a ledger that calls itself complete still has to contain them.

**#1010's `Closes #1009` points at an already-closed issue.** #1009 was closed
while the PR stayed open, so the closing keyword will be a no-op at merge and the
PR has to justify itself on its own merits rather than inherit one from the link.

## Self-modification map

| File | Action | Content |
|------|--------|---------|
| `030_cross_links.md` | MODIFY | append `## Matrix` with one row per pair above plus every issue with `no open PR` |
| any other file | — | none |

## Executable commands

Runnable as-is; `REFS` is the referent set from the ledger, no placeholders.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
REFS="1017 241 1009 914 922 1023 1025 1026 671 949 1016 253 899 916 917 533 572 942 1024"
for n in $REFS; do
  gh api "repos/lidge-jun/opencodex/issues/$n" \
    --jq '"\(.number) " + (if .pull_request then "PR" else "ISSUE" end) + " \(.state) \(.title[0:70])"'
done

# scope comparison for the one live supersede-shaped pair
gh pr diff 1036 --name-only
gh pr diff 1056 --name-only
gh pr diff 999 --name-only
```

## Known candidate pairs (to verify, not assume)

| Pair | Claim | What must be checked |
|---|---|---|
| #1036 → #1017 | PR title says `(#1017)` | Does the PR's conversion cover every invalid payload shape the issue reports, or only the reported one? |
| #999 → #241 | PR title says `(#241)` | #999 is docs-only. Does documenting the Desktop remote allowlist limitation actually resolve #241, or does it only describe it? |
| #1056 → #241 | "preserve routed models in desktop picker" | Same issue as #999 from the code side. If both are open against one issue, they are not duplicates but two halves — say which. |
| #1047 / #1002 | both touch the vision sidecar | #1047 syncs captions into Responses passthrough; #1002 makes sidecar reasoning configurable. Overlapping files, different intents — check for a real conflict. |
| #1047 / #1024 | #1024 reports post-#956 vision sidecar gaps | Does #1047 close the reported gap, or a different one? |
| #937 / #872 / #870 / #812 | four provider-preset PRs, all against #572 | #572 is a batch program. These are siblings, not duplicates; the matrix should say so explicitly so a future round does not close three of them. |
| #947 / #942 | prior art says #947 conflicts with #942 | Verify #942's current state; a conflict against a merged PR is a rebase task, against an open one it is a coordination task. |

## Coverage direction

The matrix runs both ways:

- **Issue → PR:** for each open bug-class issue, is there an open PR claiming it?
  An issue with no PR and no owner is the real backlog.
- **PR → Issue:** for each open PR, does its linked issue still reproduce? A PR
  fixing an already-fixed issue is closable with a pointer.

## Table format

```
| issue | PR(s) | relation | equivalence basis | resolution |
```

`relation` ∈ {fixes, partially-fixes, documents-only, sibling-of-batch,
conflicts-with, continuation-of, descendant-of, rebase-of, rebase-provenance,
supersedes, motivating-report, closes-already-closed, overlap-to-check,
unrelated}. Every ledger row maps to exactly one of these.

## Accept criteria

- Every row of the reference ledger above appears in the matrix with a resolution.
- Every open bug-class issue appears with either a PR or the literal `no open PR`.
- No `duplicate` or `superseded` verdict without a named equivalence basis.

---

# Matrix (executed)

## Issue → PR coverage, all 17 bug-class issues

| issue | open PR(s) | relation | equivalence basis | resolution |
|---:|---|---|---|---|
| #1017 | #1036 | fixes | #1036 converts structured edit tools into apply_patch calls; the issue's own defect claim is **UNVERIFIED** pending a reporter capture (see `010`) | PR is 297 behind and draft; its premise needs the same capture the issue needs |
| #1024 | #1047, #1002 | overlap-to-check | #1047 writes captions into the Responses passthrough; #1002 adds sidecar reasoning config; #1024's open half is `opencode-zen` carrying no vision classification (`src/providers/registry.ts:1652`) — neither PR touches that path | neither closes it; adjacent, not covering |
| #1043 | no open PR | — | shares #1024's root cause; see the equivalence section | unowned |
| #1046 | no open PR | — | n/a | unowned |
| #1057 | no open PR | — | n/a | unowned |
| #1059 | no open PR | — | n/a | unowned |
| #1061 | no open PR | — | n/a | unowned |
| #1045 | no open PR | — | n/a | already fixed on `dev`; needs no PR |
| #241 | #999, #1056 | documents-only + partially-fixes | #999 documents that the residual allowlist lives in the Desktop client; #1056 changes proxy-side picker code — disjoint halves of one report, neither a superset of the other | two halves, not duplicates |
| #540 | no open PR | — | n/a | unowned feature |
| #92, #417, #418, #796, #904, #919, #994 | no open PR | — | n/a | reporter-blocked, upstream, or consumed elsewhere |

## The pairs that needed a real equivalence judgment

**#1043 and #1024 are one defect with two issue numbers.** Both lanes landed on
the same anchor: `opencode-zen` has no `noVisionModels` entry and no modality
metadata, so the fail-closed image strip never activates
(`src/providers/registry.ts:1652`). #1043 reports the 400 that results; #1024
reports the probe gap that reveals it. They are not duplicates in the "close one"
sense — #1024 also covered NVIDIA (fixed by `f557f9173`, ancestor) and a `TR`
provider that is not in the registry at all. The honest statement: **one shared
root cause, two different blast radii.** A fix for the zen classification closes
#1043 outright and closes the remaining live half of #1024.

**#999 and #1056 against #241 are complements, not rivals.** #999 documents that
the remaining allowlist filter lives in the Desktop client, where no proxy-side
change reaches it. #1056 preserves routed models in the picker from the code side.
A future round must not close one as a duplicate of the other: they answer
different halves of the same report, and #999's own body states the limitation is
outside this repository.

**#1047 vs #1002 do not conflict.** Both touch the vision sidecar, but #1047
writes into the Responses passthrough path and #1002 adds configuration for
sidecar reasoning. Same subsystem, disjoint intent. Their real problem is
identical and unrelated to each other: both sit 201 and 331 commits behind.

**#937 / #872 / #870 / #812 are siblings of the #572 batch, not duplicates.**
#572 is a program to promote a verified batch of OpenAI-compatible providers;
each PR adds a different pair (Nscale+Vultr, DigitalOcean+Scaleway,
SambaNova+Nebius, Apertis). Closing three of them as duplicates of the fourth
would destroy the batch. Recorded here explicitly because the shared issue link
makes them *look* like duplicates in any tooling that keys on `#572`.

**#947's conflict target is already closed.** Prior art said #947 conflicts with
#942 and the author must resolve it
(`devlog/_plan/260803_bug_backlog_stack/070_outcome.md:100-103`). #942 is now
`PR closed`, so the coordination blocker is gone and only the mechanical rebase
remains.

**#1010's `Closes #1009` is a no-op.** #1009 is `ISSUE closed`. The keyword will
not close anything at merge, and the PR's justification has to stand on its own.

## Direction check: issues with no PR

Fourteen of the seventeen bug-class issues have no open PR: #1043, #1046, #1057,
#1059, #1061, #1045, #540, #92, #417, #418, #796, #904, #919, #994. Only three
(#1017, #1024, #241) have one. Of the fourteen, five are real open defects with
no owner: **#1043, #1046, #1057, #1059, #1061**. That is the actual actionable
backlog — smaller and more tractable than a 39-issue tracker suggests, because
the rest are reporter-blocked, upstream, or already fixed.
