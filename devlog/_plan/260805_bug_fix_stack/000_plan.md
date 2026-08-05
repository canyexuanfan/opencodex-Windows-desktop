# 000 — Plan: bug-fix stack from the 260805 triage

## Objective

Fix the defects the 2026-08-05 triage proved at code level, one PR per defect,
each with a regression test that fails without the fix.

Source of candidates: `devlog/_plan/260805_issue_pr_triage/010_issue_verdicts.md`.
That unit produced seventeen verdicts; five were real open defects with no owner.
Four of them are fixable here. The fifth (#1059, the Windows suite) needs a
Windows runner this machine does not have, and stays out.

## Base

| Fact | Value |
|------|-------|
| Base | `origin/dev` = `aaa71967a` |
| Branch | `codex/260805-bug-fix-stack` |
| Dirty files preserved | `src/usage/log.ts`, `tests/usage-log.test.ts` (user-owned, untouched) |

## Layer map

Ordered by file independence, not by size. Three of the four layers touch
disjoint files, so they are **independent branches off `dev`**, not a linear
stack. Only #1057 and #1043 share a file (`src/providers/registry.ts`), and they
touch lines ~1300 apart with no semantic overlap.

| Layer | Issue | Files | Overlaps |
|-------|-------|-------|----------|
| 010 | #1057 DeepSeek ladder | `src/providers/registry.ts:349-360`, `src/config.ts`, 3 test files | shares registry.ts with 020 |
| 020 | #1043 (+ live half of #1024) | `src/providers/registry.ts:1652`, `tests/vision-sidecar-e2e.test.ts` | shares registry.ts with 010 |
| 030 | #1061 test harness | `tests/native-profile-crash-boundaries.test.ts`, `tests/helpers/native-profile-startup-child.ts` | none |
| 040 | #1046 startup app-server | `src/codex/app-server-processes.ts`, `src/codex/desired-state.ts` | none |

**Stack shape decision: linear.** Even though only two layers share a file, a
linear stack off one branch keeps the CI story simple and matches the repository's
documented stacked-child workflow in `AGENTS.md`. Each child targets its parent's
head; after the parent lands, the child retargets to `dev`.

Order: `010 → 020 → 030 → 040`. #1057 goes first because it is the most
self-contained change to `registry.ts`; #1043 then edits a different region of the
same file without conflict.

## What the design research changed

Three read-only `gpt-5.6-terra`/`sol` lanes and two `gpt-5.6-luna` search lanes ran
before any code was written. Two findings materially changed the plan, and both
would have produced a wrong patch if we had gone straight from the triage anchors
to an edit.

**#1043: the reporter's own suggested fix is the wrong one to ship first.** The
issue proposes stripping images whenever `inputModalities` lacks `"image"`. The
control-flow lane found that modality metadata is *not reliably populated* — live
`GET /v1/models` returns `undefined` when the provider omits a recognized modality
field (`src/codex/catalog/provider-fetch.ts:719-743`), and live-discovered
modalities are never copied into the request-time provider config
(`src/router.ts:84-110`). So a modality-keyed fix would silently do nothing for
exactly the provider that motivated the issue. It also found a deliberate
regression guard asserting that unlisted models keep forwarding images
(`tests/vision-sidecar-e2e.test.ts:163-193`), which a default-on strip would
break. The narrow fix — classify the zen models explicitly — ships now; the
modality-driven default is a follow-up that needs the metadata to become canonical
first.

**#1057: the shared mapping table may be wrong per model.** DeepSeek's official
thinking-mode docs give a native ladder of `low / high / max`, which matches the
reporter. But the same table maps requested `xhigh` differently per model —
`xhigh -> max` for `deepseek-v4-pro` and `xhigh -> high` for `deepseek-v4-flash`.
The code currently applies one shared map to both. A confirmation lane is running
against the official table before this layer is written; if the per-model
difference holds, the fix is not a one-line constant change.

**#1046: the obvious fix is unsafe at boot.** The existing
`afterCatalogWriteHandleAppServers()` has a `restart: true` branch that SIGTERMs
long-lived app-servers and explicitly warns that active turns may be interrupted
(`src/codex/app-server-processes.ts:738-742`). Wiring that into unattended startup
would kill a user's in-flight turn on every service start. Only the warning path
is startup-safe.

## Scope boundary

**IN:** `src/providers/registry.ts`, `src/config.ts`, `src/codex/app-server-processes.ts`,
`src/codex/desired-state.ts`, the named test files, and this devlog unit.

**OUT:** #1059 (needs a Windows runner); any change to the vision default for
unlisted models (follow-up, not this stack); process termination at startup; the
user's dirty `src/usage/log.ts` and `tests/usage-log.test.ts`; merging any PR;
closing any issue by hand.

## Accept criteria, all layers

1. The regression test fails on the pre-fix tree and passes after — ablation output recorded in the layer's decade doc.
2. `bun run typecheck` exits 0.
3. The affected test files pass.
4. No existing test is rewritten to accommodate the change unless that test was locking the defect itself, and the decade doc says which and why.
5. Each PR fills `.github/PULL_REQUEST_TEMPLATE.md` and links its issue.

Criterion 4 is the one with history: `devlog/_plan/260804_overnight_triage/000_dispositions.md`
records a PR rejected for rewriting a regression contract to make a broader change
pass. Two layers here legitimately update tests (#1057's ladder assertions, #1061's
harness) — both are tests that encode the defect, and both are named in advance.
