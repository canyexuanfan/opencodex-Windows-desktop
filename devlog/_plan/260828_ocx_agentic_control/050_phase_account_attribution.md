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

**Do not attach at the `genericFailoverAccountId` assignment.** That line
(core.ts:2888) sits inside `if (isGenericFailoverProvider(route.providerName, route.provider))`
at :2887, and that predicate (`src/oauth/generic-account-failover.ts:82`) requires
`provider.authMode === "oauth"` and excludes `{openai, anthropic}`. The rotation
paths are gated more tightly still: `isGenericOAuthFailoverEnabled` (:128) also
requires failover enabled and, at :164, **at least two stored accounts**.

Attaching there would mean the ordinary case — one xai or cursor account, failover
off — never stamps a label, while every test listed below still passes. That is the
C-ACTIVATION-GROUNDING-01 trap, and it would make accept criterion 1 unreachable.

Attach instead at the `resolved` snapshot itself (core.ts:2878-2879), which carries
`resolved.accountId` unconditionally for every OAuth provider on this path,
**outside** the failover gate:

```ts
         const resolved = await getValidAccessTokenSnapshot(route.providerName);
         replayOAuthCredentialSnapshot = { accountId: resolved.accountId, generation: resolved.generation };
+        // Attribution is independent of failover: a single-account xai/cursor user
+        // must still get per-account usage. Stamping inside the
+        // isGenericFailoverProvider gate below would silently skip them.
+        stampOAuthAccountLabel(logCtx, route.providerName, route.provider, resolved.accountId);
```

Then repeat it after **each rotation site** (core.ts:4317, :4618, and the
`genericFailoverAccountId` re-resolutions at :4696 and :4781 — five sites, not the
three an earlier draft named). A request that rotated accounts must attribute to the
account that actually served it. Reuse one helper so the sites cannot drift:

```ts
// Lives in src/codex/account-label.ts (Lab-clean: it imports only node:crypto).
export function stampOAuthAccountLabel(
  logCtx: { accountLogLabel?: string },
  providerName: string,
  provider: OcxProviderConfig,
  accountId: string | undefined,
): void {
  if (!accountId) return;
  // openai keeps its own p-label producer; anthropic already folds the account
  // into the provider label (core.ts:2876 formatAnthropicProviderForLog).
  if (provider.authMode !== "oauth") return;
  const base = baseProviderLabel(providerName);
  if (base === "openai" || base === "anthropic") return;
  logCtx.accountLogLabel = oauthAccountLogLabel(accountId);
}
```

**Activation scenario (for C).** Provider `xai`, `authMode: "oauth"`, exactly one
stored account, generic failover **disabled**. Observable effect: the persisted usage
entry carries `accountLogLabel: "o<hex6>"` and `ocx usage --json` reports one
non-`legacy-ambiguous` account row. If that case does not stamp, the phase has
re-created the bug it set out to fix. A second scenario with two accounts and
failover enabled proves the rotation re-stamp.

Boundary: this must not reach into `src/lab/`. `core.ts` is one of the three files
`tests/core-lab-boundary.test.ts` guards, so the helper lives in
`src/codex/account-label.ts` or a `src/lib/` leaf, never in a Lab module.

## 050.3 — let the label survive attribution

The gate is `accountLabelForAttribution` at `src/usage/summary.ts:687`, called from
`buildAccounts` at :705 as `accountLabelForAttribution(input.provider, input.accountLogLabel)`.
An earlier draft of this doc named `legacyCodexAccountLabel(entry)`, which does not
exist — that function takes `provider: string` and is only the fallback.

Current:

```ts
function accountLabelForAttribution(provider: string, explicit: unknown): string | null {
  if (isCodexUsageAccountLogLabel(explicit)) return explicit;
  return legacyCodexAccountLabel(provider);
}
```

**Decide which layer owns the widening, because doing both is a no-op on top of a
no-op.** Two options, and this doc chooses the second:

1. Widen `isCodexUsageAccountLogLabel` to accept `o<hex6>`. Then :688 already passes
   the new labels and this function needs no edit at all. But the predicate's name
   then lies, and it is also the validator four writers use to *reject* bad labels —
   widening it there weakens validation for a rename's convenience.
2. **Chosen:** keep `isCodexUsageAccountLogLabel` as the Codex-specific predicate,
   add a sibling `isOAuthUsageAccountLogLabel`, and widen only the attribution gate:

```ts
 function accountLabelForAttribution(provider: string, explicit: unknown): string | null {
   if (isCodexUsageAccountLogLabel(explicit)) return explicit;
+  // An explicitly stamped non-Codex label is authoritative for any provider (#2699).
+  // The legacy fallback below stays openai-only: guessing for a non-Codex row would
+  // silently merge unrelated accounts into 'legacy-ambiguous'.
+  if (isOAuthUsageAccountLogLabel(explicit)) return explicit;
   return legacyCodexAccountLabel(provider);
 }
```

The writers in `src/usage/log.ts` and `src/server/request-log.ts` accept either
family via `ACCOUNT_LOG_LABEL_RE` from 050.1, so persistence and attribution are
widened in exactly one place each.

Leave `legacy-ambiguous` behavior for unlabeled openai rows untouched (`buildAccounts`
sets `ambiguous: label === LEGACY_AMBIGUOUS_ACCOUNT_LABEL` at :708). wp4 renders the
marker, so those rows stay honest.

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
