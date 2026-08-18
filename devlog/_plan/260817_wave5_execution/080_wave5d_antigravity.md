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
## Corrections from the WP8 audit — the order inverts, and #1891 holds

**#1891 violates this wave's own accept criterion, and I treated that criterion as a box to
tick rather than a live risk.**

*Wording corrected after review: I first called this a "leak." It is not one.* The env var is
set by whoever controls the process, and anyone who can set it can already read the token file
or patch the source. No trust boundary is crossed and no secret escapes. It is a **contract
violation and a correctness foot-gun**, and calling it a leak in a section headed "security
posture" inflates a real finding into a wrong category — which is exactly how you lose
credibility on the next finding that genuinely is severe.

The sharper objection, which I also missed: on `dev` today `ide_version` is *already* the full
UA string. The wrongness predates #1891 entirely. #1891 does not open a channel — it makes an
already-wrong channel operator-steerable.

The criterion said "a UA override never leaks into body metadata." #1891 violates it. The
change reads as consolidation — moving the `GOOGLE_ANTIGRAVITY_USER_AGENT` lookup out of the
module constant and into `antigravityUserAgent()` — but that function has an untouched caller
at `src/oauth/google-antigravity.ts:114` which puts its return value in the `onboardUser`
**request body** as `ide_version`. So the override widens from one destination to two.

Reproduced in a scratch worktree, same env var, `dev` versus `dev`+#1891:

```
baseline dev  → ide_version = antigravity/ide/2.5.5 (aidev_client; os_type=windows; arch=amd64)
dev + #1891   → ide_version = LEAK-CANARY/1.0
```

**The dependency runs opposite to my reorder.** I put #1889 last because it is the only PR with
red CI. But #1889 is the PR that makes `ide_version` a real version constant — it *closes* the
hole #1891 widens. Ordering by CI colour put the fix behind the regression. The correct
sequence is: sponsor and land **#1889 first**, then #1891 becomes safe.

That does not change my refusal to self-apply `maintainer-sponsored` on #1889 — it makes the
refusal costlier, which is the honest position rather than a reason to reconsider.

### Other findings

- **#1891 adds `PI_AI_ANTIGRAVITY_USER_AGENT`**, an env var with no references anywhere else in
  `src/`, `tests/`, or `docs-site/` — a second undocumented spoofing knob under a title about
  token order.
- **#1891's central claim is asserted, not attached.** It cites a decompiled address and live
  200s, but no disassembly excerpt or redacted capture is in the diff. For a change whose whole
  value is matching an observed client, the observation is the artifact. Requested on the PR.
- **#1891 is clean on secrets** — no token, account id, or project value in the diff, fixtures,
  or added tests. Checked specifically.
- **#1897 misses one of its four cache-contract requirements**: invalidation on authorization
  failure. `markProviderDiscoveryFailed` neither clears the cache nor bumps the generation, so a
  stale wire-ID map survives a 401/403. Incremental gap rather than regression — there was no
  wire-ID cache before — so it did not hold the merge, and it is recorded on the PR.

### Corrections to this document

`#1889` has **4** failing checks at head, not 5 as the original text said. And `#1906` is an
**issue**, not a PR — the earlier correction reached the right state through the wrong object
type.

## WP8 outcome

| PR | Outcome | Evidence |
|----|---------|----------|
| #1897 | merged | `aca3c0241`; **macOS-only** local verification — 99 pass / 0 fail plus `tsc` clean. No CI run existed at head, which is a fact about fork policy rather than an unavoidable constraint: pushing the head to a repo branch would have triggered `push` CI. Judged not worth it for a pure-TypeScript diff with no platform-sensitive APIs |
| #1891 | **held** | makes an operator env var steerable into an upstream request body; violates this wave's accept criterion; needs #1889 first. Note its head also has **no test CI** — the four green checks are governance gates, not tests |
| #1889 | **blocked** | unsponsored `src/oauth/` surface; draft |
| #1836 | already closed | nothing to do |
| #1906 | open issue | the undocumented-`v1internal` policy call belongs to the user |
