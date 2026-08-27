# 005 — A-gate audit record (wp1)

Reviewer: independent read-only `gpt-5.6-sol` explorer, high effort, against
`d3481ee` (14 docs, +1769). Verdict: **GO-WITH-FIXES (blockers=7)**.

Every blocker below was **independently re-verified** against source before amending
the plan — the reviewer's conclusions were not taken on trust. Where I confirmed a
finding, the confirmation command or the source line is named.

## What the reviewer verified as CORRECT

Roughly 40 file:line anchors checked; the RCA layer held. Confirmed correct including
every claim I asked to be re-checked: `projectQuota`'s 7-key whitelist stripping
`fiveHourPercent` (account-api.ts:198) with `account.ts:89`'s unreachable first
operand; the `dispatch.ts:419`/`:428` `return 0`; `responseMessage` scanning only
three keys (runtime-api.ts:53) while the body is retained on the throw (:86);
`reason`+`hint` at management-auth.ts:455-459; all four
`writeServiceApiTokenFile` callers; the six account-label anchors;
`filterRequestLogs` having no `model` clause while `observe.ts:70` still sends one;
#2702's routes being PUT; `ApiKeyUsage` as a discriminated union with its warning
comment; the 20 dead `USAGE` exports having zero external consumers; the shadowed
`GET /api/storage`; all 7 non-literal registration mechanisms; the star-POST consent
gate; and no `devlog/` security-triage or Lab-boundary violation.

## Blockers and dispositions

### C1 — 050.3 patched a function that does not exist — FOLDED

The doc showed `legacyCodexAccountLabel(entry)`. Confirmed by reading
summary.ts:680-690: `legacyCodexAccountLabel` takes `provider: string`, and the real
gate is `accountLabelForAttribution(provider, explicit)` at :687, called from :705.
The shown patch would not compile, and the widening decision sits in
`isCodexUsageAccountLogLabel` at :688.

Folded: 050.3 rewritten against `accountLabelForAttribution`, with the
widening-ownership choice made explicit (add a sibling predicate rather than widen the
Codex one, because that predicate is also the writers' validator).

### C2 — the stamp site is inside an unreachable gate — FOLDED

Confirmed: core.ts:2887 wraps the `genericFailoverAccountId` assignment in
`isGenericFailoverProvider`, which requires `authMode === "oauth"` and excludes
openai/anthropic (`src/oauth/generic-account-failover.ts:82`); the rotation paths at
:4317, :4618, :4696, :4781 additionally require `isGenericOAuthFailoverEnabled`,
which needs failover on and >= 2 accounts (:164).

A single-account xai user would never stamp, while every listed test passed — exactly
C-ACTIVATION-GROUNDING-01. Folded: attach at the `resolved` snapshot
(core.ts:2878-2879) outside the gate; five re-stamp sites named, not three; and an
explicit activation scenario recorded (xai, oauth, one account, failover off) with the
observable effect C must check.

### H1 — the recurrence-guard regex was vacuous — FOLDED

The reviewer ran the proposed pattern against real `dispatch.ts`: one match at
`handleLogin` (:195), and neither :419 nor :428, because `[^)]*` cannot span
`deps.args.slice(1)`. The guard would have greened over the regression it existed to
catch. Folded: `[^;]*` form, plus a mandatory red-first assertion against a pre-fix
fixture.

### H2 — the counts were wrong — FOLDED

Confirmed by importing the modules: `CLI_COMMANDS.length` = 58, visible = 52,
`DISPATCH_COMMANDS.size` = 57 — the docs said 49/43/52. Usage blocks are 37 by `rg`,
of which 20 are the dead exports. Folded into 000 and 002, and 020.2's scope restated.

### H3 — 040's sketch had four wrong signatures — FOLDED

Confirmed: `apiJson(deps, baseUrl, method, path, body?, options?)` (account-api.ts:88),
`apiError(json, fallback: string)` (:123), `printData(value, wantsJson, lines?: string[])`
(runtime-api.ts:288), `configAndType(deps, name)` synchronous (account-extended.ts:230),
and no `takeFlag`/`takeOption` in that module. Folded: sketch rewritten against
`cmdPriority` (account-extended.ts:637-690) with a signature table naming each wrong
assumption, and the `status === 0` transport check ordered first.

### H4 — `accounts[]` is blanked under any filter — FOLDED

Confirmed at summary.ts:943 with the reasoning at :865-872. 004's "unconditionally
includes `accounts`" was false for filtered requests, and
`ocx usage --provider xai --json` is the natural agent query. Folded: 004 qualified,
and 030 now prints an explicit withheld-rows note instead of an empty table, with a
new accept criterion and test.

### H5 — two verbs already exist — FOLDED

Confirmed: `auto-switch` at account.ts:302 -> `cmdAutoSwitch`, `reset-credits` at
:313 -> `handleAccountAuthCommand`. 001's reach column and 060's seed list corrected.

## Medium findings

- **M1 (parity gate could pass vacuously) — FOLDED.** The two-direction check cannot
  verify the 40+ non-literal routes, so an under-declared registry was undetectable.
  Added a third per-module count-reconciliation check with an enumerated non-literal
  allowlist. This mattered most: the parity gate is the unit's central claim.
- **M2 (`ACCOUNT_USAGE` has 4 live consumers) — FOLDED.** Confirmed at account.ts:127,
  :213, :256, :317. Documented the stderr-vs-stdout and `return 1`-vs-`process.exit`
  difference and chose the smaller path: re-source the text, keep the call sites.
- **M3 (inverted `responseMessage` args) — FOLDED.** Real order is `(body, status)`;
  both snippets corrected to verbatim source.
- **M4 (wp3 overloaded) — FOLDED.** Split 020.5 into wp3b (`025`). The split is
  dependency-shaped, not effort-shaped: the contract tests consume wp3's capability
  table, so wp3b is a genuine successor phase (PHASE-SPLIT-01 forbids effort buckets,
  not successor phases).

## Low findings

L1 (bare `proxy-liveness.ts` path) and L2 (usage-report table lines are :119/:129, not
:115/:124) folded. L3 was a confirmation, not a defect: 010.3's 404/409 mapping for the
account client is a breaking change and 010 already disclosed it.

## Residual

None open. All 7 blockers and all 4 Mediums are folded as concrete amendments; no
blocker was rebutted rather than fixed. The reviewer's own recommendation — fix
C1/C2/H1-H3 before wp2 starts, correct H4/H5 so wp4/wp7 are not sized against bad
inventory, and answer M1 before wp3 lands — is satisfied by these amendments.

