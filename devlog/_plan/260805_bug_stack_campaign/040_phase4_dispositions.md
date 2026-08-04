# 040 — Phase 4: dispositions (closes and verdicts with evidence)

User authorization on record: close issues/PRs that are already resolved on
`dev`. Anything beyond that (closing contributor PRs as superseded, asking
reporters for info) is executed only when this document's table names it, and
ambiguous cases go back to the user first.

## Close as already-fixed (issue)

| Item | Action | Evidence to cite in the close comment |
|------|--------|----------------------------------------|
| #806 | close | `d52b387db` is an ancestor of `origin/dev`; GUI/CLI/docs wording split shipped (`gui/src/i18n/en.ts:1296-1315`) |

## Verification-needed issues — campaign verdicts

| Item | Disposition | Basis |
|------|-------------|-------|
| #994 | leave open; allowlist location identified, needs reporter's provider/model + wire capture | `src/providers/registry.ts:918-958,1637-1655` |
| #904 | leave open; `eeef7a32a` fixed surrogate boundaries but the original capture is still needed | 001 triage |
| #796 | leave open pending live Ark credential verification; structural fix `d3abf4345` + regression test already on dev | `tests/volcengine-ark-assistant-content.test.ts:90-125` |
| #418 | leave open; latest same-run trace does not reproduce; needs reporter's current trace | `src/server/responses/collaboration.ts:243-304` |

## Contributor PRs superseded by stack PRs

Disposition happens only after the corresponding stack PR lands on `dev`:

| PR | Stack successor | Disposition when landed |
|---:|-----------------|-------------------------|
| #966, #922 | stack-02 (#914) | close with a pointer to the landed fix (user confirm at that point) |
| #928 | stack-03 (#893) | same |
| #940 | stack-04 (#938) | same |
| #1006 | stack-05 (#875) | adopt or close-with-pointer, decided at that cycle's P |

## Stale/broken PRs outside the stack

#933 (CI fail), #557 (CI fail), #936 (conflicting, needs security review per
MAINTAINERS), #569 (conflicting), #997/#947/#1000/#978/#983/#985 (unverified,
policy-only CI). These stay open; the campaign does not close contributor work
that merely needs the author. Recorded here so the surface state is complete.
