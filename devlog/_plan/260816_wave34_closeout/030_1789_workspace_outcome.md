# 030 — #1789: stop calling a workspace denial a credential failure

## Verified defect

`CodexUpstreamOutcomeClass` is `success | credential | quota | transient | caller | neutral | unknown` — no workspace or entitlement member (`src/codex/routing.ts:129`).

`classifyCodexUpstreamOutcome` maps **both** 401 and 403 to `credential` (`src/codex/routing.ts:330`), and a `credential` outcome unconditionally calls `markAccountNeedsReauth`, clears quota health, and drops thread affinity (`src/codex/routing.ts:1678`).

So a K12 workspace 403 tells the user to re-authenticate a credential that is perfectly valid. `tests/codex-routing.test.ts:377` currently PINS that mapping.

A richer-looking classifier exists on a different path (`src/codex/quota-rejection.ts:11`, distinguishing `authentication-error` from `permission-error`), but it splits on STATUS alone — it does not inspect the body for a workspace shape. So it cannot be reused as-is to tell the two kinds of 403 apart.

## Fix

1. Add `workspace` to `CodexUpstreamOutcomeClass`.
2. Introduce an explicit discriminator rather than sniffing strings at the classifier. The upstream rejection is already parsed once; carry its structured outcome forward:

```ts
type CodexUpstreamEvidence = {
  status: number | "connect_error" | "timeout" | "connect_neutral";
  /** Set when the upstream body identified a workspace/entitlement denial rather than a bad credential. */
  denial?: "workspace" | "entitlement";
};

classifyCodexUpstreamOutcome(evidence: CodexUpstreamEvidence): CodexUpstreamOutcomeClass
```

   401 stays `credential`. A 403 with `denial: "workspace"` becomes `workspace`; a 403 with no denial evidence stays `credential`, so the change fails safe toward today's behavior.

3. **Thread it through every call site.** `recordCodexUpstreamOutcome` is called from multiple paths; each must pass the evidence it already has instead of a bare status, or the split silently never fires. Enumerate and update them all — a partially-threaded change is worse than none, because it makes the classification depend on which path happened to report.

4. In the outcome handler, a `workspace` result must NOT call `markAccountNeedsReauth`. Store it keyed by (account, workspace-scoped route) so the account stays usable elsewhere, and surface a workspace-denial diagnostic. Define that key explicitly — an account-wide flag would quarantine the account for every route, which is the same over-reaction in a new place.

## Tests

Two existing tests encode the current policy and both must be revisited, not just the first: the classifier assertion at `tests/codex-routing.test.ts:377`, and the 403 quarantine behavior at `:429`. Update them to the new contract.

Add: a workspace-denial 403 does not set reauth and leaves the credential usable on a non-workspace route; a bare/unclassifiable 403 still behaves exactly as today; 401 is unchanged; and a workspace denial recorded through one call site is classified the same as one recorded through another.
