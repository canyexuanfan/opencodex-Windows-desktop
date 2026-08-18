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
