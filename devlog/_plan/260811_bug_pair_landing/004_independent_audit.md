# 004 — Independent audit of the integrated branch

A reviewer that wrote none of this code audited `git diff origin/dev...dev`
after the rebase onto `9ec2e2d94`. It returned **FAIL** with three high-severity
blockers and one medium. Each was re-checked against upstream before being
accepted or rejected, because "this branch has defect X" and "this branch
introduced defect X" are different claims and only the second blocks a merge.

## Blocker 1 — stale config saves discard edits: NOT OURS

The reviewer probed two cases and both reproduced here:

```text
disk-only addition:   Expected: ["grok-new"]        Received: undefined
same-leaf conflict:   Expected: "disk-writer-value" Received: "stale-live-value"
```

Both reproduce **identically on `origin/dev` `9ec2e2d94`**, which carries none
of this branch's work:

```text
OUR TREE  {"ourEditLanded":["mock/m"]}          (grokExcludedModels absent)
UPSTREAM  {"ourEditLanded":["mock/m"]}          (grokExcludedModels absent)
```

So this is the repository's existing whole-document write policy, not a
regression from the seven pairs. The same-leaf half is documented policy, stated
twice in the file the reviewer cites: `src/config.ts:2908` ("Same-leaf conflicts
prefer the pending live management mutation") and the `saveConfigPreservingClaudeCode`
contract at 2993.

The finding is real as a product observation and worth its own issue. It is not
a merge blocker for this branch, and fixing it here — the reviewer proposes
field-scoped mutations or tombstone tracking — would be a config-subsystem
redesign smuggled into a bug-fix batch.

## Blocker 2 — scheduler rollback ownership: PARTIALLY OURS, ALREADY NARROWED

Correct that `rollbackElevatedSchedulerTask()` deletes by name with no nonce
check. It exists verbatim on `origin/dev` at `src/service.ts:1001`, introduced by
`0deda7caf`, and this branch neither wrote nor widened it. Our commit added a
*separate* nonce-verified path and pointed the new install transaction at it:

| Call site | Path |
|---|---|
| `src/service.ts:1941` (fresh install rollback) | `rollbackWindowsSchedulerTaskOwnedByAttempt` |
| `src/service.ts:2624` (staged transaction rollback) | `rollbackWindowsSchedulerTaskOwnedByAttempt` |
| `src/service.ts:1128`, `1262` (legacy dashboard finalizer) | `rollbackElevatedSchedulerTask` (upstream) |

The reviewer's TOCTOU point on the nonce-checked path is fair: the query and the
elevated delete are not one atomic operation, so a replacement registered in that
window can still be deleted. Closing it properly needs an attempt-unique task
name or an elevated attempt-bound transaction, which changes the installed task's
identity — a user-visible change to Windows service registration that belongs in
its own unit with a real Windows test host. `windows N/4` is SKIPPED (#1059), so
we cannot even exercise it here.

What this branch does is strictly narrow the window versus upstream: before, the
install path deleted by name unconditionally; now it proves ownership first.
That is an improvement, and the doc claim in `030` overstated it as a guarantee.
Corrected there.

## Blocker 3 — shim rollback unlinks a marker-bearing wrapper: NOT OURS

The reviewer's probe shows a concurrent wrapper carrying the public OpenCodex
markers can be adopted as owned and unlinked. That logic is entirely contributor
`comfuture`'s in PR #1441 (`git log --format=%an -- src/codex/shim.ts` →
`comfuture`); this branch added no shim code and no correction commit there.

It is a real narrowing of an already-narrow race: an attacker who can write the
wrapper path during the probe window can already replace the user's `codex`
outright. The fix the reviewer wants — stage and atomically rename a fingerprinted
inode — is right, and it belongs to that PR's next round rather than to a merge
gate for work that did not create it.

## Blocker 4 — devlog overstates and cites pre-rebase SHAs: OURS, FIXED

Accepted without argument. The `003` outcome table listed SHAs that now only
exist on `backup/pre-rebase-260811`, and `030`/`070` claimed ownership guarantees
the probes above disprove. Both corrected: the table carries the rebased SHAs and
the guarantees are stated as the narrowing they actually are.

## What the audit confirmed

- ARM64 fallback is narrowly gated by `WindowsSystemDirectoryFfiUnavailableError`;
  ordinary resolver, API, and path failures cannot reach it. No SID, token, or
  account identifier was added to any log or serialization.
- The only production `flushAntigravityReplay()` caller uses `Promise.allSettled`,
  so the new rejection warns without skipping worker cleanup, listener stop, or
  lifecycle release.
- Catalog byte comparison and sync preflight behave correctly; the representative
  ablations fail as intended, so the tests are not vacuous.
- Upstream's fresh-process shard batching (#1469) still selects every changed test
  file — our new tests do run in CI.
- Contributor authorship survived the rebase; maintainer corrections remain
  separate commits.
- Repo hygiene passes: no gitlinks, no security triage in `devlog/`.
- Fresh verification by the reviewer: 433 pass / 0 fail focused, typecheck clean,
  privacy scan passed, repo hygiene 11 pass / 0 fail.

## Disposition

Three of four blockers describe defects this branch did not introduce and cannot
responsibly fix inside it. They are recorded here so they are not lost. The one
finding that is ours — overstated documentation — is corrected. The branch merges.
