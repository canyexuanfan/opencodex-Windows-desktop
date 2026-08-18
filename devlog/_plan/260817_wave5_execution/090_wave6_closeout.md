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
