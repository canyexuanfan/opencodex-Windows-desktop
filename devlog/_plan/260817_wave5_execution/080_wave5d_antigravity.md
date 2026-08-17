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
