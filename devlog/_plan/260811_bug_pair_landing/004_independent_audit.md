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

## Blocker 3 — shim rollback unlinks a marker-bearing wrapper: OURS, FIXED

The first draft of this section argued the defect was "not ours" because the shim
code is contributor `comfuture`'s. The reviewer rejected that and was right:
`git log origin/dev..dev -- src/codex/shim.ts` is **13 commits**, all of which
this branch adds. Authorship decides credit; the merge boundary decides
responsibility. A defect that arrives on `dev` because we merged it is ours to
answer for, and the earlier "this branch added no shim code" sentence was simply
false — it came from an unscoped `git log` that also swept in history already on
`origin/dev`.

The reviewer's probe, run against both trees:

```text
origin/dev: {"installed":true,"injected":true,"final":"concurrent"}   1 pass
dev:        {"installed":false,"injected":true,"final":"original"}    0 pass / 1 fail
```

Root cause: `writeShim()` wrote straight to `wrapperPath`, and ownership was then
established by `stat`-ing that path. A replacement landing between the write and
the fingerprint is indistinguishable from our own file, so it was adopted and
later unlinked by rollback.

Fixed on this branch: the Unix wrapper is now created as its own inode
(`.opencodex-staging.<pid>.<uuid>`, opened `wx` so it can never inherit an
existing file) and renamed into place. `rename()` preserves `dev`/`ino` and
updates only `ctime`, so identity is the inode pair captured from the file we
created. If the destination's inode no longer matches after the rename, the
existing `wrapperChangedDuringProbe` gate refuses the install and restores the
launcher it moved aside.

Two details worth recording because they cost time:

- Fingerprinting the staged file *before* the rename fails: `ctimeMs` changes,
  and the fingerprint comparison is exact. Capture `dev`/`ino` instead, and
  fingerprint the destination after the rename.
- A probe that "replaces" the file with `writeFileSync` proves nothing here:
  that truncates our inode in place. A faithful updater writes a new file and
  renames it over ours, which is what the regression now does.

Regression: `tests/codex-shim.test.ts`, "Unix fresh install refuses to adopt a
wrapper replaced between the write and the fingerprint". Red before the fix
(`Expected: false, Received: true` — the install adopted the replacement), green
after, with the whole shim suite at 67 pass / 0 fail.

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

Round 1 raised four findings; round 2 rejected my triage of one of them and was
right to.

| Blocker | Verdict | Action |
|---|---|---|
| 1 — config stale saves | predates the branch; reproduces identically on `origin/dev`, and the same-leaf half is documented policy | recorded, not fixed here |
| 2 — scheduler rollback | legacy name-only path is upstream's; our commit narrows the install path but leaves a TOCTOU window | narrowing documented honestly in `030` |
| 3 — shim ownership | **ours**, arrives with the 13 shim commits this branch adds | **fixed**, with a red-then-green regression |
| 4 — devlog overclaims | ours | fixed: rebased SHAs, guarantees restated as narrowings |

The lesson from round 2 is worth keeping: "the contributor wrote it" is an answer
about authorship, not about whether we are responsible for what we merge.
