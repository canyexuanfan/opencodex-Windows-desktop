# 031 — wp4 implementation record

Branch `codex/ocx-dto-fidelity` off `codex/ocx-capability-registry`. Implements `030`
(#2700, #2703, #2705). No server change, as `030` required.

## What landed

| File | Change |
|---|---|
| `src/cli/account-api.ts` | `projectQuota` keeps the two 5h keys; `paused` added to `AccountRow`, `CodexAccountDto`, and the `fetchCodexRows` mapping |
| `src/cli/account.ts` | `statusText` prints `paused`, leading and additive to `selected` |
| `src/cli/account-extended.ts` | `refreshLine` delegates to `quotaParts` instead of keeping a second quota dialect |
| `src/cli/usage-report.ts` | `accounts` on the input type; ACCOUNT table between PROVIDER and MODEL; withheld-rows note under a filter |
| `src/cli/access.ts` | `formatKeyRows` renders usage columns with a union-safe ambiguous marker and a dataset footer |
| `src/cli/capabilities.ts` | `details[]` for `account list` and `usage` |
| `tests/cli-dto-fidelity.test.ts` | 19 tests, new file |

## The test `030` proposed could not detect the bug it targeted

This is the finding worth keeping. `030`'s test table asks
`tests/cli-account.test.ts` to assert that "`formatAccountTable` shows a 5h-only quota
instead of `unknown`". That assertion **passes with the defect fully present**:
`formatAccountTable` takes an `AccountRow` directly, and the field was being dropped one
layer earlier, inside `projectQuota`.

Confirmed rather than reasoned: after writing the renderer test and seeing it green, the
`projectQuota` fix was reverted and the renderer test **stayed green**. Only then was the
coverage moved to drive `fetchCodexRows` with a server payload, which does go red on the
same revert.

A renderer test for a projection bug is the same category of mistake as the bug: the layer
that looks responsible is not the one that is.

The projection test also asserts the pre-existing windows still survive, so a future
whitelist edit cannot add the 5h keys while silently dropping `shortPercent`.

## `paused` is additive, not exclusive

`030` says `paused` outranks `selected`. Implemented as **both**, in that order. A
paused-but-selected account is the state an operator most needs named — requests route to
it while the pool believes it is held out of rotation — and printing only the winner of a
precedence rule hides exactly that case.

## Two quota dialects in one file

`refreshLine` gated its entire quota block on `weeklyPercent`/`monthlyPercent`, so a 5h-only
account printed `quota: unknown` while `quotaParts`, five lines below in the same file,
rendered the same DTO correctly. Teaching the second dialect about a third window would
have left the disagreement in place, so it delegates instead.

## The ambiguous union is a contract, not a hint

`ApiKeyUsage` is a discriminated union whose `{ambiguous:true}` variant carries **no**
numbers, and the type comment states why: an optional marker beside `requests7d: 7` invites
a consumer to render the 7. So the CLI prints `ambiguous` spanning the numeric columns and
never a `0`. A test asserts the output contains no standalone `0` in that case, because
reporting zero requests for a key that may be in heavy use is the dangerous answer for
someone deciding what to revoke.

`attributionSince` and `historyTruncated` print once as a footer. Without
`attributionSince`, an absent `lastUsedAt` cannot be read at all: "never used" and "nothing
is attributable yet" look identical.

## The withheld-rows case

`projectUsageSummary` blanks `accounts` under any provider or model filter, because account
rows are not provider-partitioned in a way the projection could honestly re-derive. "What
did this provider cost me per account" is the most natural way an agent would ask, so an
empty table would have answered "no accounts used this provider" — a different and wrong
answer, and the same silently-wrong-output class this unit exists to remove.

The renderer states the withholding, and the same sentence is recorded in the `usage`
capability's `details[]` so `ocx capabilities --json` carries it.

## A plan inaccuracy

`030` describes `formatUsageReport` as though it returned text and gives an insertion point
of "line ~115". It returns `string[]`. The first version of the new tests asserted
`toContain` against an array and failed for that reason rather than for any product defect.

## Verification

- `tsc --noEmit`: clean.
- 6 focused suites: 189 pass, 0 fail, 748 expect() calls.
- Non-vacuous: reverting `projectQuota` turns the projection test red; the renderer test
  alone does not move, which is why both exist.

## Left for wp6

ACCOUNT rows stay empty for xai and cursor until wp6 stamps their labels (#2699). The
renderer lands first deliberately, so wp6's proof is visible the moment it lands.
