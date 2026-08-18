# WP6 — Wave 5B: continuation, provider, usage semantics

Merge order is a dependency chain, not a priority list.

```
#1888 → #1902 → #1884 → #1892 → #1904 → #1898
```

## #1888 — scope combo continuation replay (CHANGES_REQUESTED, head cd3367193)

Restoring `previous_response_id` state must match on provider, adapter, model,
destination, credential/account, and an immutable parent snapshot. Anything
less lets a failover or rotation resume another context's continuation. Same
key-completeness principle as WP4 — land WP4's identity plumbing first where
they touch the same record.

Gate: credential-rotation and failover destination-change tests before merge.

## #1902 — ClinePass stale OMP reasoning tiers (head b8983c912, BLOCKED/mergeable)

Narrow. Rebase on `1208bd25c`, exact-head CI, merge.

## #1884 — DeepSeek V4 tool replay loops (head 99b0bbc38, 25 checks green)

Narrow replay-loop fix. Gate: structured tool call and reasoning continuation
preserved on a live-shaped fixture.

## #1892 → #1904 — FastWire (#1886)

Order is load-bearing: #1892 is the A0 characterization that locks current
service-tier behavior; #1904 changes it. Merging #1904 first would leave the
production change with no red/characterization baseline. #1904 is still draft.

## #1898 — pacing anchored to transport starts (draft, head 7279aca7c)

Still design-stage. Required before merge:

- queued time vs transport-start time distinguished
- retries do not double-advance the pacing clock
- a cancelled waiter does not consume a slot
- per-account pacing isolation
- deterministic fake-clock concurrency test

If those are not met, #1898 defers with a recorded reason rather than shipping
a timing change on inference.

## Accept criteria

Each PR either lands with focused tests green on `origin/dev`, or carries a
recorded blocker disposition naming exactly what is missing. Merge order is
preserved and verified with `git merge-base --is-ancestor`.
## Order amended at WP6 P — #1888 moves to the end

State changed since the Gate 0 inventory. #1888 is now **draft**, head `3b04d3f81`, with four
failing checks — and the failures are not code:

```
PR hygiene failed: unsponsored_surface
PR quality gate failed: unsponsored_surface
```

`.github/scripts/pr-sponsored-surface.cjs` lists `src/oauth/` as a restricted path, and
#1888 touches `src/oauth/index.ts`. The gate clears only when a maintainer applies the
`maintainer-sponsored` label, which is exactly the authorization boundary `AGENTS.md`
describes for auth surfaces. **An agent applying that label to its own merge would defeat
the control**, so #1888 is reported rather than unblocked, and the train reorders around it:

```
#1902 → #1884 → #1892 → #1904 → #1898   (then #1888, once sponsored)
```

None of the other five touch a restricted path — verified per PR. #1888 loses nothing by
going last: its dependency claim was that continuation scope should precede the others, but
the five remaining PRs touch disjoint files (`src/router.ts` + `providers/derive.ts`;
`adapters/cline-pass-*`; two fastwire test files; `src/chat/inbound.ts`;
`providers/request-pacing.ts`), so none of them consumes its output.

One thing to carry into #1888's eventual review: it now also touches
`src/responses/reasoning-replay-cache.ts`, `src/server/responses/core.ts` and `src/types.ts` —
the three files WP4 changed for the durable destination identity. It will need a rebase, and
the reviewer should check that its account-scoping work composes with the destination scoping
rather than duplicating it.
