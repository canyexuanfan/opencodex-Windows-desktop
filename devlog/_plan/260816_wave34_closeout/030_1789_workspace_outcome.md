# 030 — #1789: stop calling a workspace denial a credential failure

## Verified defect

`CodexUpstreamOutcomeClass` is `success | credential | quota | transient | caller | neutral | unknown` — no workspace or entitlement member (`src/codex/routing.ts:129`).

`classifyCodexUpstreamOutcome` maps **both** 401 and 403 to `credential` (`src/codex/routing.ts:330`), and a `credential` outcome unconditionally calls `markAccountNeedsReauth`, clears quota health, and drops thread affinity (`src/codex/routing.ts:1678`).

So a K12 workspace 403 tells the user to re-authenticate a credential that is perfectly valid. `tests/codex-routing.test.ts:377` currently PINS that mapping.

A richer classifier already exists but on a different path: `src/codex/quota-rejection.ts:11` distinguishes `authentication-error` from `permission-error`. It does not feed account health.

## Fix

1. Add `workspace` to `CodexUpstreamOutcomeClass`.
2. Split the 403 branch. 401 stays `credential`. 403 becomes `workspace` **when** the upstream body/error code indicates workspace or permission denial (reuse the discrimination already implemented in `quota-rejection.ts` rather than writing a second one); an unclassifiable 403 stays `credential` so the change fails safe toward the existing behavior.
3. In the outcome handler, a `workspace` result must NOT call `markAccountNeedsReauth`. It should mark the account unusable for this workspace-scoped route and surface a workspace-denial diagnostic, leaving the credential intact.

The signature already carries what is needed:

```ts
classifyCodexUpstreamOutcome(
  outcome: number | "connect_error" | "timeout" | "connect_neutral",
)
```

It must gain the upstream error detail to tell the two 403s apart. Thread the already-parsed rejection reason through rather than re-reading the body.

## Tests

Update `tests/codex-routing.test.ts:377` — it asserts the behavior being fixed — and add: a workspace-shaped 403 does not set reauth and leaves the credential usable elsewhere; a bare/unclassifiable 403 still behaves as today; 401 is unchanged.
