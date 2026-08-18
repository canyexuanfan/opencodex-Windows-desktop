# WP8 — Wave 5D: Antigravity fingerprint and discovery

```
#1889 → #1891 → #1897   (then close #1836 as superseded)
```

This wave touches auth/provider fingerprinting, so it carries the security
review expectation from `AGENTS.md`: no token, account, or project value may
appear in a snapshot, log, or test fixture.

## #1889 — drop synthetic `x-goog-api-client` (draft, **5 failing checks**)

Failing CI is the first thing to resolve; a fingerprint change with red checks
is not a merge candidate. Removes a synthesized header and an unverified fixed
`ide_version`.

## #1891 — User-Agent token order + `auth_method` (head 10b88e155, 14 green)

Aligns with the 2.5.5 decompilation. Keep the live `fetchAvailableModels` and
`generateContent` success evidence attached; the value of this PR is that it
matches an observed client, not a plausible one.

## #1897 — match live agy model discovery (head 38c25aed8, 24 green)

Removes hardcoded model injection and preserves CCA-discovered wire ids exactly.
Required cache contract: publish discovery with a generation; invalidate on
credential rotation, provider removal, and authorization failure/revocation;
never reuse one account's discovered models for another; stay fully separate
from the direct Google alias table (see WP1).

## Accept criteria

1. Captured `onboardUser` and `loadCodeAssist` requests show no synthetic
   `x-goog-api-client` and the intended UA token order.
2. A UA override never leaks into body metadata.
3. Discovered wire ids round-trip byte-exact.
4. Every capture fixture is redacted.

## Closure

#1836 closes as superseded once #1889 and #1891 land and its unique tests are
migrated. #1906 stays closed unless policy changes to allow undocumented
`v1internal` inference.
## WP8 P — simulated, and the reorder holds

All three merge clean onto current `origin/dev` in the corrected order:

```
#1891 CLEAN → #1897 CLEAN → #1889 CLEAN
```

So the `client-fingerprint.ts` overlap between #1889 and #1891 that the earlier audit predicted
does not actually conflict at these heads. Good news, and worth stating plainly rather than
leaving the prediction standing.

**#1889 is blocked by the same governance gate as #1888.** Its four failing checks are
`hygiene` and `enforce-target`, not tests — it touches `src/oauth/google-antigravity.ts`, and
`pr-sponsored-surface.cjs` lists `src/oauth/` as restricted. The `maintainer-sponsored` label is
the record that a security review happened, so an agent applying it to clear its own merge
would make that record false. Reported, not cleared. It is also still draft.

That is precisely why the reorder to `#1891 → #1897 → #1889` was right: leading with the only
red-CI PR would have held the whole train behind a gate no agent should touch.

## Readiness at head

| PR | State | Gate |
|----|-------|------|
| #1891 | ready | not draft, 0 failures, `REVIEW_REQUIRED` |
| #1897 | ready | not draft, 0 failures, `REVIEW_REQUIRED` |
| #1889 | **blocked** | draft + unsponsored auth surface |

## Correction to this document

The original text said "#1836 closes as superseded" and "#1906 stays closed." Both were
inverted and were corrected in `002_merge_order_corrections.md`; re-confirmed here at head:
**#1836 is CLOSED** already, and **#1906 is OPEN**. Nothing to do on #1836. #1906 is a genuine
open question about whether the Antigravity adapter should reach `/v1internal`, which is the
undocumented-protocol policy decision reserved for the user.

## Security posture for this wave

These PRs change how the client identifies itself upstream. Before merging either, the diff
must show no token, account id, or project value reaching a snapshot, log, or test fixture —
`AGENTS.md` treats credential handling as a release blocker, and a fingerprint change is
exactly where a capture fixture tends to acquire one by accident.
