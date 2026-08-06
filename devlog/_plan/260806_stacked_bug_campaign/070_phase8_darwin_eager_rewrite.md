# 070 — Phase 8: Darwin eager rewrite relay gate (#1127, PR #947)

Credit: **0xWinner98** (reporter, #1127) and **biao**
(`WZBbiao <16611004+WZBbiao@users.noreply.github.com>`, PR #947 — the Darwin
predicate idea). Adoption: **reimplement** on current transport code.

## Defect

`selectEagerPath` rejects every rewrite on Darwin
(`src/lib/bun-stream-caps.ts:99`), while inline payload rewrite and the rewrite
budget are wired only for Win32 (`src/server/responses/core.ts:2128`). #1025
repaired the snapshots, but the transport gate closed with #928 was never
reopened for macOS — so the macOS half of #893 is still broken.

## Why reimplement

PR #947 has the right predicate but conflicts with current `dev` across 14
files, and its tests assert through fixed `settle()` waits
(`tests/relay-eager.test.ts:269-284`) — timing-based assertions that pass for
the wrong reason. The predicate is ported; the test shape is replaced with a
deterministic `onDone` promise plus a bounded failure timeout.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/lib/bun-stream-caps.ts` | MODIFY | `selectEagerPath` keeps an explicit Darwin `eager-relay` selection eligible when a client rewrite is required. Darwin `auto` is **not** broadened — only the explicit selection |
| `src/server/responses/core.ts` | MODIFY | At ~`:2083`/`:2128`, compose payload/block rewrites when either Win32 forced rewrite **or** a Darwin-selected eager path is active; pass `rewriteBudget` whenever inline rewriting is active rather than only under `win32EagerRewrite` |
| `tests/bun-stream-caps.test.ts` | MODIFY | Full platform × mode × rewrite-required policy matrix |
| `tests/relay-eager.test.ts` | MODIFY | Replace fixed `settle()` waits with an `onDone` promise and a bounded failure timeout |
| `tests/responses-snapshot-repair-server.test.ts` | MODIFY | Darwin rewrite activation reaches the client |

**Win32 behavior is unchanged** — its forced-rewrite path is separate and stays
as is. Broadening Darwin `auto` is deliberately avoided: the default path should
not change transport strategy as a side effect of a bug fix.

## Verification

- `bun test tests/bun-stream-caps.test.ts tests/relay-eager.test.ts tests/responses-snapshot-repair-server.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

macOS is the host here, so the Darwin path is exercised natively — this is the
one platform phase with real local coverage.

## PR

Stack 07, base = stack 06 head. `Closes #1127`. Credits 0xWinner98 for the
macOS-specific report and biao for the predicate from #947, and states why the
patch was rebuilt rather than picked.
