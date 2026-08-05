# 040 — WP5: action queue and unverified ledger

> **Status: EXECUTED.** Sections above `# Queue (executed)` are the phase spec as
> it stood when WP5 ran; the queue, ledger, and accounting at the bottom are the
> result.

## What this phase must produce

1. A recommended action queue, ordered by dependency.
2. A complete `UNVERIFIED` ledger.
3. The surface accounting that shows nothing was dropped.

## Ordering rule

Dependency, never effort. An action goes after another when it *cannot* be done
first — not when it is bigger. Concretely, the expected dependency spine:

```
CI health (#1061, #1059)
  └── gates confidence in every other verdict, because a red suite
      makes "tests pass" meaningless as evidence for anything below
       ├── defect fixes with no external dependency (#1043, #1045, #1046, #1017, #1057)
       │     └── PR reviews that touch the same subsystems
       └── reporter-blocked items (#904, #796, #418, #994) — parallel, not blocked by CI
```

Each queue entry names its blocking predecessor explicitly, or states `no blocker`.

## Authorization boundary

Every entry is labeled with the authority it needs:

- `autonomous` — a code change inside normal contribution rules.
- `needs-user` — closing an issue, commenting on a contributor's PR, merging,
  retargeting, or anything that writes to GitHub.
- `needs-second-maintainer` — the security-review class (#936, #557).

This unit produces none of the writes. The queue is a recommendation; executing
any `needs-user` entry requires the user to say so.

## Unverified ledger format

```
| item | what could not be verified | why | what would verify it |
```

Expected residents, based on what this session structurally cannot reach:

- #796 — live Volcengine Ark credential.
- #904, #418, #994 — reporter captures.
- #1059 — a Windows runner.
- #1061 — a macOS release-train CI run.

Naming these as UNVERIFIED is the point. A triage that quietly upgrades
"I read the code and it looks right" into "verified" is worse than one that
admits the gap.

## Self-modification map

| File | Action | Content |
|------|--------|---------|
| `040_action_queue.md` | MODIFY (done) | appended `# Queue (executed)`, `## Unverified ledger`, `## Accounting` |
| any other file | — | none |

## Exact queue-item ledger

The queue is built from the closed verdict tables, not re-derived. Its source
rows are:

```
from 010 (real-open-defect):     1061 1059 1057 1046 1043 1024 1017
from 010 (already-fixed-on-dev): 1045
from 010 (needs-reporter-info):  904 796 994 418
from 010 (out-of-scope):         919 540 417 241 92
from 020 (every disposition):    all 25 open PRs
from 030 (pair resolutions):     1036/1017, 1056+999/241, 1047+1002/1024, 1043+1024
```

Every queue entry names its source row. An entry with no source row in `010`,
`020`, or `030` is a scope escape and must be removed.

## Executable commands

Runnable as-is; used to confirm the queue's preconditions at execution time.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
# 1. did anything in the frozen surface close or merge since the freeze?
gh issue list --state open --limit 100 --json number --jq '[.[].number]|sort|@json'
gh pr list  --state open --limit 100 --json number --jq '[.[].number]|sort|@json'

# 2. re-confirm the one closable issue before recommending a close
git merge-base --is-ancestor 4177345021 origin/dev && echo "1045 fix ANCESTOR"
bun test tests/system-restart.test.ts

# 3. re-confirm both drift-candidate ancestries
for sha in eeef7a32a d3abf4345; do
  git merge-base --is-ancestor $sha origin/dev && echo "$sha ANCESTOR" || echo "$sha NOT_ANCESTOR"
done
```

## Queue entry shape

```
| # | action | source row | blocking predecessor | authority |
```

## Surface accounting (the exact identity to reproduce)

```
39 open issues (frozen 2026-08-05T13:33:08Z)
 = 17 bug-class             -> 17 verdict rows in 010
 +  2 other-unit work items -> #1048, #1049, owned by 260804_codex_write_substrate
 + 20 enhancement/roadmap   -> #1060 #1058 #974 #823 #822 #821 #820 #809 #755
                               #695 #657 #572 #561 #415 #414 #386 #201 #178
                               #177 #95
post-freeze arrival: #1062 (recorded, not counted)

25 open PRs = 25 verdict rows in 020
```

Any discrepancy is a bug in this unit, not a rounding difference.

## Accept criteria

- Every queue entry has a blocking predecessor or `no blocker`.
- Every queue entry has an authority label.
- The unverified ledger names a concrete verification path for each row.
- The accounting table balances.

---

# Queue (executed)

Ordered by dependency. Nothing here has been executed against GitHub — this unit
holds no close, comment, merge, or label authority, and every `needs-user` row
waits on an explicit instruction.

| # | action | source row | blocking predecessor | authority |
|--:|---|---|---|---|
| 1 | Close #1045 as fixed, citing `4177345021` (ancestor) and `bun test tests/system-restart.test.ts` → 24 pass | `010` #1045 | no blocker | needs-user |
| 2 | Fix #1061's harness: bound the `restart.exited` await with a deadline + kill fallback, and make `waitFor()` prove parseable JSON rather than file existence | `010` #1061 | no blocker | autonomous |
| 3 | Triage #1059 into its five failure families as separate work items; correct the "~207" figure to "at least 113, count aborted by a Bun panic" | `010` #1059 | entry 2 — a hanging macOS leg makes the platform matrix unreadable while it stands | autonomous |
| 4 | Classify `opencode-zen` models in the registry — one change closing #1043 and the reproducible half of #1024 | `030` #1043/#1024 | no blocker | autonomous |
| 5 | Correct the DeepSeek effort ladder (`src/providers/registry.ts:349,353,1185`) and the two tests that currently lock the wrong ladder | `010` #1057 | no blocker | autonomous |
| 6 | Call `afterCatalogWriteHandleAppServers()` on the startup sync path for #1046 | `010` #1046 | no blocker | autonomous |
| 7 | Review #1018 — the only PR that is green, mergeable, and inside the freshness gate | `020` #1018 | entries 2–3, since a red platform matrix makes "CI green" weak evidence for any merge | needs-user |
| 8 | Ask the four reporters for the captures that unblock #904, #796, #994, #418 — and for #1017, the malformed payload that would confirm or refute it | `010` ×5 | no blocker (parallel to everything) | needs-user |
| 9 | Route #936 and #557 to the second-maintainer security review they have been waiting on since 07-27 | `020` #936, #557 | no blocker; it has never been a technical blocker | needs-second-maintainer |
| 10 | Give the 21 out-of-gate PRs a single honest rebase-or-close message; for #715 specifically, decide between re-authoring and closing rather than asking for a fifth rebase | `020` ×21 | entry 7 — settle the reviewable one before asking twenty authors to rebase into a queue that is not moving | needs-user |

### Why this order, and not the obvious one

The obvious order starts with the five unowned defects, because they are the most
satisfying to fix. The dependency order starts with CI, because entries 2 and 3
decide whether "the tests pass" means anything for entries 4–7. A macOS leg that
hangs for 30 minutes and a Windows leg that is dispatch-only are not background
conditions — they are the reason every green check in this repository is weaker
evidence than it looks.

Entry 10 is last for a reason that has nothing to do with its size. Asking
twenty-one contributors to rebase into a queue where only one PR is currently
reviewable produces twenty-one rebased PRs and the same bottleneck. The
behind-counts are a symptom of merge latency, and telling authors to fix a symptom
they did not cause is the least useful thing on this list.

## Unverified ledger

| item | what could not be verified | why | what would verify it |
|---|---|---|---|
| #1017 | that the Cursor adapter corrupts a valid payload | the anchors prove the tool boundary exists, not that it mangles input; the lane over-called this and the audit caught it | the reporter's malformed wire capture, or a regression test driving the path |
| #1059 | the "~207 failures" figure and whether the families share a cause | the cited run aborted on a Bun internal panic after 113 counted failures | a full Windows shard run to completion |
| #1061 | that the hang reproduces | one local macOS run passed 2/2; the failure is load-dependent | a macOS release-train CI run |
| #796 | that the Ark 400 is gone in practice | needs a live Volcengine Ark credential | a reporter or maintainer run against Ark |
| #904 | that the U+FFFD corruption is gone | the surrogate fix landed but the original capture was never provided | the reporter's failing capture |
| #994 | which provider/model path produces it | the report does not name them | reporter's provider/model + wire capture |
| #418 | that V2 custom-parent delegation still fails | the latest same-run trace does not reproduce | reporter's current trace on a current build |
| #1024 (`TR` half) | Kimi behavior through `TR` | `TR` is not a built-in registry provider | the reporter's provider configuration |
| every PR diff | semantic correctness of 25 contributor diffs | this unit judged structure, CI, and freshness — not code review | per-PR review, which is entry 7 and entry 10 work |

Nine rows. That is roughly a third of the surface, and stating it plainly is the
point: a triage that reported seventeen confident verdicts would be less useful
than one that reports eight solid ones and names what the other nine are waiting
on.

## Terminal outcome

`DONE` for the triage objective; the recommended actions are a queue, not a
completed program. Every `needs-user` and `needs-second-maintainer` entry is
blocked on authority this unit deliberately does not hold.

---

# Queue (executed)

Ordered by dependency. An entry sits below another only when it *cannot* run
first — never because it is larger.

| # | action | source | blocking predecessor | authority |
|--:|---|---|---|---|
| 1 | Bound the teardown in `tests/native-profile-crash-boundaries.test.ts:194-197` with a deadline and kill fallback; fix the `waitFor()`/parse race at :182-183 | 010 #1061 | no blocker | autonomous |
| 2 | Close #1045 as fixed by `4177345021` | 010 #1045 | no blocker (ancestry proven, suite 24/24) | **needs-user** |
| 3 | Classify `opencode-zen` vision capability at `src/providers/registry.ts:1652` | 010 #1043 + #1024 | no blocker | autonomous |
| 4 | Correct the DeepSeek effort ladder at `src/providers/registry.ts:349,353,1185` and the tests locking the wrong ladder | 010 #1057 | no blocker | autonomous |
| 5 | Call `afterCatalogWriteHandleAppServers()` on the startup sync path, not only on explicit CLI `sync` | 010 #1046 | no blocker | autonomous |
| 6 | Triage the five Windows failure families separately | 010 #1059 | **entry 1** — a hanging macOS phase test corrupts release-train signal, and CI health gates the credibility of every "tests pass" claim below | autonomous, needs a Windows runner |
| 7 | Review and land #1018 | 020 #1018 | no blocker — the one reviewable PR | **needs-user** (merge) |
| 8 | Ask #1019 and #1010 to fix `hygiene`; ask #1056 to rebase back into the gate | 020 | entry 7 (same subsystem review capacity) | **needs-user** (comment) |
| 9 | Route #936 and #557 to a second maintainer for security review | 020 | no blocker; it has waited since 07-27 | **needs-second-maintainer** |
| 10 | Decide #715: re-author against current `dev`, or close with thanks | 020 #715 | entry 9 (same account-pool/credential area) | **needs-user** |
| 11 | Tell the 13 behind-but-clean PR authors what specifically changed under them | 020 lane P3 | entries 3–5 (they touch the same paths those fixes move) | **needs-user** (comment) |
| 12 | Ask reporters of #904, #796, #418, #994 for the specific captures named in 010 | 010 lane B/C | no blocker; runs in parallel with everything above | **needs-user** (comment) |

Entries 1–5 are the only fully autonomous code work. Everything with a
`needs-user` label is a GitHub write this unit deliberately did not perform.

## Unverified ledger

| item | what could not be verified | why | what would verify it |
|---|---|---|---|
| #1059 | the "~207 failures" figure | the cited run aborted on a Bun internal panic in shard 4; only 113 explicit failures are recoverable (30+41+35+7) | a completed Windows dispatch run across all four shards |
| #1061 | that the hang reproduces | one local macOS run passed 2/2; the failure is load-dependent | a macOS release-train CI run with the current test |
| #1017 | the malformed payload on the wire | needs a live Cursor credential and `cursor/grok-4.5` | a captured request/response pair from the reporter |
| #1024 | the `TR` provider half | `TR` is not a built-in registry provider; behavior depends on reporter configuration | the reporter's provider config |
| #796 | that the shipped fix resolves the reporter's case | needs a live Volcengine Ark credential | one authenticated Ark tool-turn request |
| #904 | the U+FFFD reproduction | `eeef7a32a` fixed surrogate boundaries; the original capture was never supplied | the reporter's failing file capture |
| #418 | V2 delegation failure | the latest same-run trace does not reproduce | the reporter's current trace on a current build |
| #994 | which allowlist path fires | the report does not name the provider/model | reporter's provider/model + wire capture |
| #92, #417, #241 | upstream behavior | the defect lives outside this repository | an upstream fix or a Desktop-client change |

Nine of seventeen bug-class issues are blocked on evidence this session cannot
produce. Naming that is the point: a triage that quietly upgrades "I read the code
and it looks right" into "verified" is worse than one that admits the gap.

## Terminal outcome

`DONE` for the triage objective, with the caveat that no GitHub write was
performed and none was authorized. The five autonomous fixes (entries 1, 3, 4, 5,
and 6's investigation) are recommendations, not work this unit did.
