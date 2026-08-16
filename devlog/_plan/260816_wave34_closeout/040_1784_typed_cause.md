# 040 — #1784: stop manufacturing `reason: "disk"`

## Verified defect

There is no exception type to propagate — failures are DATA. `CatalogDisposition` carries `reason: provider-auth | provider-network | disk` plus `phase`, `retryable`, `partialWrite`, and **no cause field** (`src/codex/convergence-types.ts:160`).

The cause is discarded twice:

1. `createManagementConvergeCodex` catches, inspects two message substrings for busy/database admission, and otherwise returns hard-coded `failed/disk` without storing the caught error (`src/codex/management-convergence.ts:52`, `:62`, `:93`).
2. `src/server/management-api.ts:150` uses a bare `catch {}` and again manufactures `reason: "disk"`, choosing gather-vs-commit purely from whether invocation had begun.

Tests pin both collapses (`tests/codex-management-convergence.test.ts:67`, `tests/codex-convergence-contract.test.ts:303`).

So a malformed request and a genuine ENOSPC are indistinguishable to the operator, and both are reported non-retryable.

## Fix

Extend the disposition rather than inventing the roadmap's `CatalogConvergenceError`:

```diff
 type CatalogDisposition = {
   ...
   reason: "provider-auth" | "provider-network" | "disk"
+        | "request-invalid" | "admission" | "internal";
+  /** Non-sensitive cause summary: error name + redacted message. Never the raw body. */
+  cause?: { name: string; detail: string };
 };
```

- `request-invalid` for programming/shape errors (malformed scope, bad factory input).
- `admission` for lock/contention/database-busy, which IS retryable.
- `internal` for anything genuinely unclassified — explicitly not `disk`.
- `disk` narrows to real filesystem failures.

Populate `cause` from the caught error at both sites, passing it through `redactSecretString` so nothing operator-controlled leaks into a management response.

## Tests

Update the two pinning tests to assert the NEW classification rather than `disk`, and add: a malformed scope yields `request-invalid` with a cause; a simulated lock-busy yields `admission` with `retryable: true`; a simulated write failure still yields `disk`; and a token-shaped string inside an error message does not survive into the response.
