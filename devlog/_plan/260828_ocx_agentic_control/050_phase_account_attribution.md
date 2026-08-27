# 050 — wp6: per-account usage attribution for OAuth providers (#2699)

Closes: #2699. Branch: `codex/ocx-account-attribution` off `codex/ocx-new-verbs`.

The only phase in this unit that touches the request path and the shared usage-log
schema. It is last among the code phases for that reason.

## Root cause recap

The label type is Codex-only by construction:

`src/usage/log.ts:14` — `type CodexUsageAccountLogLabel = "main" | \`p${string}\``,
validated at :16 against `CODEX_ACCOUNT_LOG_LABEL_RE = /^p[a-f0-9]{6}$/`
(`src/codex/account-label.ts:6`). Four writers drop a non-matching label
(usage/log.ts:369, :456; server/request-log.ts:262, :381). The only producer,
`codexAuthContextLogLabel` (account-label.ts:32), returns `undefined` outside a
Codex `pool`/`main-pool` context. And `legacyCodexAccountLabel` (summary.ts:681)
returns `null` unless `baseProviderLabel(provider) === "openai"`, so `buildAccounts`
drops the row at :706.

The identity is already resolved at request time: `core.ts` puts
`resolved.accountId` into `genericFailoverAccountId` (core.ts:2888) purely for 429
cooldown attribution. Anthropic already folds its account into the provider label
(core.ts:2876 `formatAnthropicProviderForLog`). So xai/cursor are the gap, not OAuth
as a category.

## 050.1 — widen the label type in one place

MODIFY `src/codex/account-label.ts`.

```ts
-export const CODEX_ACCOUNT_LOG_LABEL_RE = /^p[a-f0-9]{6}$/;
+// 'p' = Codex pool account, 'o' = non-Codex OAuth provider account.
+// Both are sha256-derived hex6 digests: the label must never carry an email or a
+// raw provider account id (#2699 privacy requirement).
+export const CODEX_ACCOUNT_LOG_LABEL_RE = /^p[a-f0-9]{6}$/;
+export const OAUTH_ACCOUNT_LOG_LABEL_RE = /^o[a-f0-9]{6}$/;
+export const ACCOUNT_LOG_LABEL_RE = /^(?:main|[po][a-f0-9]{6})$/;
+
+export function oauthAccountLogLabel(accountId: string): string {
+  return "o" + createHash("sha256").update(accountId).digest("hex").slice(0, 6);
+}
```

Reuse the digest shape of the existing `fallbackCodexAccountLogLabel` (:17) so the
two label families stay visually and structurally parallel.

MODIFY `src/usage/log.ts:14`: rename the type off `Codex…` to
`UsageAccountLogLabel = "main" | \`p${string}\` | \`o${string}\`` and validate at :16
against `ACCOUNT_LOG_LABEL_RE`. The four writers then stop dropping `o…` labels
without individual edits — one regex, one type.

Collision note: hex6 is 16.7M values, so a birthday collision between two accounts
is negligible at operator scale but not impossible. Two accounts colliding merge
into one row, which is a reporting inaccuracy, not a correctness or privacy failure.
Record it rather than widening the label and breaking the existing `p` format.

## 050.2 — stamp the label in the request path

MODIFY `src/server/responses/core.ts`.

At the existing `genericFailoverAccountId` assignment (~2888), also set
`logCtx.accountLogLabel = oauthAccountLogLabel(resolved.accountId)` when the
provider is a non-Codex OAuth provider and the id is present.

Critically, repeat it after **each rotation site** (~4328, ~4629, ~5221). A request
that rotated accounts must attribute to the account that actually served it, or the
numbers are wrong in exactly the situation the operator cares about. Reuse a single
small helper so the four call sites cannot drift:

```ts
function stampOAuthAccountLabel(logCtx: RequestLogContext, provider: string, accountId: string | undefined): void {
  if (!accountId) return;
  if (!isNonCodexOAuthProvider(provider)) return;   // codex keeps its p-label producer
  logCtx.accountLogLabel = oauthAccountLogLabel(accountId);
}
```

Boundary: this must not reach into `src/lab/`. `core.ts` is one of the three files
`tests/core-lab-boundary.test.ts` guards, so the helper lives in
`src/codex/account-label.ts` or a `src/lib/` leaf, never in a Lab module.

## 050.3 — let the label survive attribution

MODIFY `src/usage/summary.ts` around `legacyCodexAccountLabel` (:681) and
`buildAccounts` (:706): an **explicit** label on the row survives regardless of
provider. Only the *fallback* path stays openai-gated.

```ts
-  const label = legacyCodexAccountLabel(entry);
+  // An explicitly stamped label is authoritative for any provider (#2699).
+  // The legacy fallback stays openai-only: guessing 'main' for a non-Codex row
+  // would silently merge unrelated accounts.
+  const label = entry.accountLogLabel ?? legacyCodexAccountLabel(entry);
```

Leave `legacy-ambiguous` behavior for unlabeled openai rows untouched. wp4 already
renders the `ambiguous` marker, so those rows stay honest.

## 050.4 — out of scope, explicitly

`supportsPerAccountQuota` (`src/providers/quota.ts:1454`, currently
`provider === "anthropic"`) is per-account **quota**, a different concern from log
attribution. Not in this phase. Recorded in `081` as a candidate follow-up so it is
a decision rather than an omission.

## Verification exception

Per `AGENTS.md`, a change to shared runtime, routing, config, or server behavior
needs full `bun run typecheck` and `bun run test`. This phase qualifies: it edits
`core.ts`, the usage-log schema, and the summary rollup.

The operator suspended local suite runs for this loop, so full validation for this
phase happens in wp9's CI pass. This is a **stated, bounded exception**, not an
oversight: it is the only phase where a focused test is insufficient by the
repository's own rule, and wp9 must not be skipped or reduced while this phase is in
the stack. If wp9's CI cannot run, this phase does not ship.

## Tests

| File | Assertion |
|---|---|
| `tests/usage-log.test.ts` | an `o<hex6>` label round-trips through persist and read; an invalid label is still rejected |
| `tests/usage-summary.test.ts` | an explicitly labeled xai row appears in `accounts[]`; an unlabeled openai row still reports `legacy-ambiguous`; a labeled non-openai row is not merged into it |
| `tests/responses-account-label.test.ts` | the label is stamped for xai and cursor, and re-stamped after a rotation so the serving account is credited |
| `tests/core-lab-boundary.test.ts` | unchanged and still green — the helper import must not pull Lab modules |

## Accept criteria

1. An xai or cursor request persists an `o<hex6>` account label.
2. A rotated request attributes to the account that served it.
3. `ocx usage` (wp4's table) shows those accounts.
4. No email or raw account id is written to any log.
5. The Lab core-boundary test still passes.

