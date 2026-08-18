# WP9 — Wave 6: gate, closeout, promotion

## Gate

`bun run typecheck` and the full `bun run test` suite on the promotion
candidate, plus `bun run privacy:scan`. Remote execution (`ssh macmini-cf`) is
preferred for the full suite per the workspace convention; `bun test --isolate
tests` avoids the cross-file environment bleed that makes raw `bun test`
misleading in this checkout.

## Closure rules (binding, from the audit's policy set)

- Close an issue only for the acceptance case the landed change actually
  satisfies. Partial fixes never auto-close an umbrella (#1849 is the model).
- **#1059** does not close without hosted Windows shard evidence — 4 shards,
  green, on the exact post-#1881 head. A local 806/806 batch is good evidence
  and still not the required gate.
- **#1795** does not close without a live SenseNova/Kimi canary showing zero
  undeclared tool calls.
- **#1843** is closable now: fixed by #1860, released in v2.24.2.
- State is judged by merge commit and branch ancestry first, GitHub API second,
  cached HTML badges last. #1881 showed an Open badge while merged.

## Promotion

`dev` → `preview` and `dev` → `main`, each verified with
`git merge-base --is-ancestor dev origin/<branch>` after push. Release
publication itself stays with the repository's canonical release workflow —
never a direct `npm publish`.

## Terminal reporting

Every roadmap item ends the campaign labeled with one of DONE / NOOP / BLOCKED /
UNSAFE / NEEDS_HUMAN / BUDGET_EXHAUSTED and the evidence behind that label. A
list of remaining independent features is not BLOCKED; it is the next work-phase.

## Policy decisions reserved for the user

The audit raised ten. These are not agent decisions and are reported, not
resolved: close-on-dev vs close-on-release; #1059 consecutive-green count;
Cursor non-loopback HTTP; Antigravity undocumented protocol posture;
needs-info lifetime; upstream-tracker accounting; #1795 recovery shape;
#1899 disposition; #1836 disposition; #1903 HTTP/1.1 default.
## Closure policy for THIS run (user decision, 2026-08-18)

> "이슈는 dev 머지되면 일단 닫아놔 이번 런만 그런거야"

Close issues when the fix reaches `dev`, not when it reaches a stable release. **Scoped to this
run only** — the standing preference remains close-on-release, so a future campaign should not
read this as precedent.

What this changes: the `released-in:vX.Y.Z` step no longer gates closure. What it does *not*
change is the evidence bar — a close still needs the fix demonstrably on `origin/dev` by
ancestry, and still must not close an umbrella from a partial fix. The three policy holds keep
their own reasons, which are about missing evidence rather than about release timing:

| Issue | Still open because |
|-------|--------------------|
| #1059 | needs hosted Windows shard evidence; no local batch substitutes |
| #1795 | needs a live SenseNova/Kimi canary showing zero undeclared calls |
| #1852 | the reported defect (sync enumeration blocking the event loop) is #1876's unmerged async work |
| #1849 | umbrella; its root cause is #1942 and unstarted |
| #1049 | assessed and unstarted; needs the publication protocol |
| #1926 | destination scope landed, but credential scope and emit-before-commit are still live in `src/bridge.ts` |
| #1866 | explicitly scoped out of #1900; no PR addresses it |
| #1730 | different provider and round from #1884's ClinePass replay fix |

Two **pull requests** are also held, and they belong in this record even though the table
above is about issues — a reader working only from this document would otherwise see no trace
of them:

| PR | Held because |
|----|--------------|
| #1891 | it makes `GOOGLE_ANTIGRAVITY_USER_AGENT` steerable into the `onboardUser` request body, violating this wave's accept criterion. Needs #1889 first, which is the one-line fix that makes `ide_version` a real constant. Detail in `080`. |
| #1889 | unsponsored `src/oauth/` surface, plus still draft. The `maintainer-sponsored` label is the record that a security review happened, so an agent applying it would falsify that record. |

Neither is affected by the close-on-dev-merge decision: both are blocked *before* merge, so the
policy that governs when a merged fix closes its issue never reaches them.
## WP9 gate result

Run on the promotion candidate (local `dev`, 6 commits ahead of `origin/dev` at the time):

| Gate | Result |
|------|--------|
| `bun test --isolate tests` | **12805 pass, 10 skip, 0 fail**, 159382 expect() calls across 826 files (452s) |
| `bun run typecheck` | clean |
| `bun run privacy:scan` | passed |

### What actually closed, under the close-on-dev-merge decision

**Two issues** closed, plus one pull request:

| Closed | Kind | Landed via |
|--------|------|-----------|
| #1894 | issue | #1739 through PR #1921 |
| #1843 | issue | #1860, already released in v2.24.0 |
| #1899 | **pull request** | superseded by the ordering assertion in PR #1923 |

The first version of this table listed all three as issues, which overstated the run.
#1899 is a PR; two issues closed, not three.

Everything else stayed open, and none of it for release-timing reasons — which is the point
worth making about the policy change. It removed a gate that was never what held these back.

### Promotion state

`dev` carries nine merged PRs from this campaign. `preview` and `main` are both behind it, and
`dev`'s own hosted CI has no completed green run on its current head — the runs at `2b12521ee`
and `aca3c0241` were both cancelled by supersession as later merges landed. The local full
suite above is the evidence that exists; a hosted run on the exact promotion head is the
evidence that does not, and promotion should carry that distinction rather than bury it.
### One merge landed on a red run

PR #1921's merge commit `9dbc5fc42` has a failing hosted run (`32026536154`). The failure is
`provider request pacing queue > spaces concurrent starts in one provider FIFO` in
`tests/request-pacing.test.ts` — a wall-clock assertion, which is the classic flake shape on a
loaded macOS runner. Evidence it is not a live regression: the file passes locally, and every
subsequent hosted run on `dev` is green including the current head.

It is recorded here because it happened, not because it blocks anything. A campaign record that
omits the one merge that landed red is exactly the kind of record you cannot trust later.

### Promotion evidence, updated

The "no completed green run" statement above is **stale and superseded**. Run `32090176020` on
`9eb3a101a` is `completed/success` with every job green — four test shards, macOS, keyring on
all three OSes, npm-global on all three, gates, storage policy, api usage.

So the hosted evidence now exists. Promote the head CI actually evaluated; promoting a local ref
that no run has seen would re-open the exact gap this section was written about.
