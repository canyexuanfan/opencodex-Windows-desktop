# 032 — The retainer is the allocator, not a live reference

Live evidence 2026-08-14, PID 56953 (post-restart, patches through b583d6497 landed):

```
rss                7,907,115,008   (7.36 GiB)
heapUsed             130,792,295   (125 MiB)
heapTotal            102,749,184
jscHeap.heapSize     110,233,413   objectCount 451,975
appOwnedBytes.retainedBytes  33,020,688 / 268,435,456 budget
appOwnedBytes.overBudgetBytes         0
enforcement.entriesDemoted            0
```

Every registered store is small and inside budget; the enforcer has never had to evict.
The watchdog samples are the decisive part:

```
heapUsed 2.99 GiB -> 186 MB -> 1.75 GiB -> 147 MB -> 153 MB -> 113 MB -> 129 MB
rss      8.53 GiB -> 9.33 GiB -> 6.93 GiB -> 7.89 GiB -> 7.88 GiB -> 7.91 GiB -> 7.91 GiB
```

The JS heap rises to gigabytes and falls back to ~130 MB, so the objects ARE collected.
RSS does not follow it down. This is allocator arena growth from a large recurring
transient, not a retained reference. Hunting for a "second retainer" (031) was correct
to close out, but it could not have found anything: there is nothing alive to find.

## The transient, measured in isolation

`.tmp/probe-cost.mjs` against the real 245 MB / 454,704-row `usage.jsonl`:

```
entries parsed from the 64 MiB tail   53,045
parse                                 408 ms   rss  69 MB -> 393 MB
summarize x12 (3 ranges x 4 surfaces) 1,432 ms rss 393 MB -> 713 MB
```

One cold `/api/usage` allocates ~644 MB and holds ~53k objects plus 12 summary
projections simultaneously. On the live proxy, competing with two active turns, the
same call measured **25.6 s wall and +680 MB RSS** (7.72 -> 8.40 GiB).

## Why it recurred every minute

`freshUntil = now + 60_000` bounds the summary cache. Warm hits are ~1 ms and all 12
combinations are pre-primed, so tab switching within the window is free. One minute
later the next tab switch pays the full cold cost again, and RSS ratchets up once more
because the allocator never returns the pages. That is the "탭전환이 너무 느려" report:
not a slow render, a 25-second blocking reparse.

## Fix

Retain the parsed tail across requests and parse only appended bytes
(`readUsageEntriesIncrementally`, src/usage/log.ts). `usage.jsonl` is append-only under a
stable identity, so the prefix is reusable. The retained rows are registered as
`usage_snapshot` under the app-owned budget and are evictable, so this trades a bounded,
accounted ~27 MB of retention for eliminating an unbounded, unaccounted ~644 MB transient.

Refusal conditions (fall back to a full bounded read): identity change, file shrink,
different `maxReadBytes`, retained window starting before the current bounded window, or a
covered offset that is not on a record boundary.

Measured after the fix, same real ledger: cold 350 ms / 388 MB, then **five further reads
in 1 ms total and +2 MB**, `fullReads` 1, `tailReads` 5, `parsedLines` flat at 53,012.

## Independent review: one real defect, folded in

Sol (gpt-5.6-sol) returned VERDICT: DEFECT FOUND on the first landed version and it was
correct. `usageLogIdentityKey` deliberately excludes size/mtime/ctime so appends share
work, which also means an **in-place rewrite that keeps the inode is invisible**. Neither
the identity check nor the shrink check sees it, so the reader could concatenate stale
retained rows with bytes from the replacement content.

Reproduced directly, guard disabled, same inode, file only grows:

```
first: aaa1,aaa2,aaa3
after: aaa1,aaa2,aaa3,bbb4     <- three rows that no longer exist in the file
```

Note the record-boundary check masks this whenever the rewrite shifts row widths, which
is why a naive regression test passes vacuously. The reproduction needs **fixed-width
request ids** so a newline still lands exactly at the previously covered offset.

Fix: carry a `prefixDigest` (SHA-256 over the last 4 KiB ending at the covered offset)
on the snapshot and re-verify it before reuse or extension. With the guard:

```
after: bbb1,bbb2,bbb3,bbb4     fullReads 2, tailReads 0
```

Sol's other three points were checked and stand as sound: retained entries stay capped by
`MANAGEMENT_USAGE_MAX_ENTRIES` and the window-refusal bound, `concat()` does not alias,
and concurrent callers share one flight and each receive a copy. Its caveat on the 512 B
per-row estimate is accepted and recorded: `usage_snapshot` accounting is coarse
telemetry for eviction ordering, not a guaranteed byte ceiling.

The regression test was driven red against the disabled guard before being accepted, so
it is not vacuous.
