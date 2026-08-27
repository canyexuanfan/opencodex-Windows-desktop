# 030 — wp4: DTO fidelity (#2700, #2703, #2705)

Closes: #2700, #2703, #2705. Branch: `codex/ocx-dto-fidelity` off
`codex/ocx-capability-registry`.

Three cases of the CLI throwing away fields the API already returns. All three are
CLI-side; no server change.

## 030.1 — `#2703`: account `paused` and the 5h window

Three drops, and the order matters: **fix the projection first**, or the renderer
fixes have nothing to render.

### (a) `projectQuota` strips the field — `src/cli/account-api.ts:195`

The whitelist omits `fiveHourPercent` and `fiveHourResetAt`, so `quotaText`'s
`quota.fiveHourPercent ?? quota.shortPercent` (account.ts:89) has an unreachable
first operand.

```ts
 function projectQuota(raw: unknown): AccountQuota | undefined {
   // ...
   return {
+    fiveHourPercent: num(obj.fiveHourPercent),
+    fiveHourResetAt: str(obj.fiveHourResetAt),
     weeklyPercent: num(obj.weeklyPercent),
     // ... existing seven keys
   };
 }
```

### (b) `paused` is not in the row types — `account-api.ts:14-27`, `:184`

```ts
 export type AccountRow = {
   // ...
+  paused?: boolean;
 };

 type CodexAccountDto = {
   // ...
+  paused?: boolean;
 };
```

Map it in `fetchCodexRows` (:230-241). The server always sends it — auth-api.ts:286
for pool accounts, :1315 for main.

### (c) renderers

`statusText` (account.ts:65) gains a `paused` branch. Precedence: `paused` outranks
`selected`, because a paused-but-selected account is the confusing state an operator
most needs named. Print `paused (selected)` rather than picking one.

`refreshLine` (account-extended.ts:253) gates the quota block on weekly/monthly and
prints `quota: unknown` for a 5h-only account. Five lines below, `quotaParts` (:275)
already does this correctly for the provider path. Rewrite `refreshLine`'s branch to
call the same helper rather than maintaining a second dialect — the two halves of one
file disagreeing is the actual defect.

### Documentation obligation

`quota` is only populated under `--quota` (`fetchCodexRows` spreads conditionally on
`forceRefresh`, :240; `cmdList` requests it only under `--quota`, account.ts:166).
That is the deliberate #2566 cost decision. So "5h in `list`" means "5h in
`list --quota`" — say so in the capability `details[]` and in the docs-site page, or
the next reporter files the same issue.

## 030.2 — `#2705`: access key usage fields

MODIFY `src/cli/access.ts:29`, which formats each key as exactly `id  name  prefix`.

Target output:

```
ID        NAME       PREFIX      REQ 7D   TOTAL   LAST USED
k_9f2a    ci-runner  ocx_live_…  1,204    18,330  2026-08-27T04:11Z
k_11bd    laptop     ocx_live_…  ambiguous        2026-08-20T22:04Z

attribution since 2026-07-29T00:00Z; older history truncated
```

Two contract requirements, both already encoded server-side:

- `ApiKeyUsage` is a **discriminated union** (`api-key-usage.ts:15`). The
  `{ambiguous:true}` variant carries no numbers, and the comment at line 11 states
  that printing a number beside an ambiguity marker is the failure mode to avoid.
  Render the word `ambiguous` spanning the numeric columns. Never `0`.
- `lastUsedAt` absent means "not used within the read window", which
  `attributionSince` disambiguates. Print `attributionSince` and `historyTruncated`
  once as a footer, not per row.

`--json` already emits the raw payload (`printData`, runtime-api.ts:288); only the
human branch changes.

## 030.3 — `#2700`: usage report `accounts[]`

MODIFY `src/cli/usage-report.ts`.

```ts
 export type UsageReportInput = {
   // ...
+  accounts?: readonly {
+    accountLogLabel: string;
+    ambiguous?: boolean;
+    requests: number;
+    totalTokens: number;
+    estimatedCostUsd?: number;
+  }[];
 };
```

In `formatUsageReport`, after the PROVIDER table (line ~115) and before MODEL, add:

```ts
  const accounts = (input.accounts ?? []).filter(a => a.requests > 0);
  if (accounts.length) {
    out.push(
      table(
        ["ACCOUNT", "REQUESTS", "TOKENS", "EST. COST"],
        accounts.map(a => [
          // 'legacy-ambiguous' rows aggregate several accounts; an operator who
          // reads them as one account draws the wrong conclusion (summary.ts:97).
          a.ambiguous ? \`${a.accountLogLabel} (ambiguous)\` : a.accountLogLabel,
          count(a.requests),
          count(a.totalTokens),
          a.estimatedCostUsd === undefined ? "-" : usd(a.estimatedCostUsd),
        ]),
      ),
    );
  }
```

Uses the existing `table`/`count`/`usd` helpers. `observe.ts:153` passes the payload
straight through, so this is one file.

### The filtered case must not silently print nothing

`accounts` is **not** unconditional. `projectUsageSummary` sets `accounts: []`
whenever a provider or model filter is active (summary.ts:943, reasoned at
:865-872) — deliberately, because account rows are not provider-partitioned in a way
the projection could honestly re-derive, and unfiltered account totals beside
filtered model totals would invite the wrong reading.

So `ocx usage --provider xai --json` returns an empty `accounts` array. That is the
most natural way an agent would ask "what did this provider cost me per account",
and an empty table with no explanation is the same silently-wrong-output defect this
unit exists to remove (compare #2704's silently-ignored `--model`).

Distinguish the two empty cases explicitly:

```ts
  const filtered = Boolean(input.filter?.provider || input.filter?.model);
  if (filtered) {
    // Not "no accounts" — the server withholds account rows under a filter because
    // they cannot be honestly re-partitioned (summary.ts:865-872).
    out.push("ACCOUNT: not reported under a provider or model filter; run without filters for per-account totals");
  } else if (accounts.length) {
    out.push(table([...]));
  }
```

Record the same sentence in the capability's `details[]` so
`ocx capabilities --json` carries it, and in wp8's recipe for per-account spend.

Rows for xai/cursor will be empty until wp6 (#2699) stamps their labels. That is
expected and is why wp6 follows this phase rather than preceding it — the renderer
lands first so wp6's proof is visible immediately.

## 030.4 — register the capabilities

Add `account list --quota`'s new columns, `access key list`'s columns, and
`usage`'s accounts table to the wp3 capability entries' `details[]`, so
`ocx capabilities --json` reflects what the commands now emit.

## Tests

| File | Assertion |
|---|---|
| `tests/cli-account.test.ts` | `projectQuota` keeps `fiveHourPercent`/`fiveHourResetAt`; `statusText` prints `paused` and `paused (selected)`; `formatAccountTable` shows a 5h-only quota instead of `unknown` |
| `tests/cli-headless-parity.test.ts` | `refreshLine` renders 5h and paused; `handleAccessCommand` prints usage columns, `ambiguous` for the union's ambiguous variant, and the footer |
| `tests/cli-usage-report.test.ts` | `accounts` table renders, filters `requests === 0`, marks ambiguous rows; an active filter prints the withheld-rows note instead of an empty table |

## Accept criteria

1. `ocx account list --quota` shows paused state and a 5h-only quota.
2. `ocx access key list` shows `requests7d`, total, `lastUsedAt`, and prints
   `ambiguous` rather than a fabricated `0`.
3. `ocx usage` renders an ACCOUNT table with ambiguous rows marked.
4. `ocx usage --provider X` states that account rows are withheld under a filter
   rather than printing an empty table.
5. No server-side change in this phase's diff.
