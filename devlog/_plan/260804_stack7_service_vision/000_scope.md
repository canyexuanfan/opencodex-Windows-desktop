# 000 — Scope: stack layer 7, the two real-but-off-theme contributor bugs

## Objective

Two overnight contributor pull requests describe real defects that the #951–#973
stack does not touch. Both were left open at the end of the overnight triage
(`devlog/_plan/260804_overnight_triage/000_dispositions.md`) with "real,
independent, own review track" as the verdict. This unit turns that verdict into
a seventh stack layer, reconstructed here, and closes the source pull requests
as superseded.

| Source PR | Author | Issue | Defect |
|---|---|---|---|
| #964 | @Yuxin-Qiao | #956 | NVIDIA NIM text-only models never activate the vision sidecar |
| #970 | @stephen-drew | — | `ocx update` re-registers the background service from a non-elevated updater |

Layer 7 is the last layer. After it lands the stack merges bottom-up from #952
and every issue a landed layer resolves gets closed with its merge commit named.

## Baseline

Measured 2026-08-04. `origin/dev` at `af3ddedb4` — layer 1 (#951) is **merged**,
so the chain is now six open layers, not six-of-six pending:

| PR | Branch | Base | State |
|---|---|---|---|
| #951 | `codex/bug-stack-plan` | `dev` | **merged** `af3ddedb4` |
| #952 | `codex/908-long-context-pricing` | #951's branch | open |
| #953 | `codex/carry-contributor-bugfixes` | #952 | open |
| #954 | `codex/545-classifier-thinking-disabled` | #953 | open |
| #955 | `codex/915-cooldown-recovery-probe` | #954 | open |
| #973 | `codex/stack6-overnight-triage` | #955 | open |
| **new** | `codex/stack7-service-vision` | #973 | this unit |

Titles currently read `stack N/6` and must be renumbered to `N/7`.

## Why these two are reconstructed rather than carried

The overnight unit carried six contributor fixes verbatim with `git cherry-pick -x`
because the code was right and only the base was wrong. These two are different:
each has a design defect that a straight cherry-pick would import.

**#964** classifies NVIDIA NIM models with a hand-written 60-entry allowlist of
text-only model ids. That is the same shape that failed three separate times in
the #955 line of work — a hand-maintained allowlist over an open string domain,
where every id the author did not think of silently takes the wrong branch. Here
the failure is asymmetric and user-visible: a text-only NIM model missing from
the list keeps exactly the bug #956 reports. NIM ships ~101 discoverable model
rows and adds more continuously, so the list is stale the day it merges.

**#970** switches the post-update service refresh from `install` to `repair`.
`repairService()` and `ocx service repair` **already exist** in this tree
(`src/service.ts:1755`, `src/service.ts:2526`), so the real change is a handful of
call sites and a pile of advice strings — not the 522-line diff the PR carries.
More importantly `repairService()` throws when the service is not installed, and
the update path runs *after* `ocx stop`. Whether that substitution is safe on all
three platforms is a correctness question the PR does not answer, and it is
answered in `020` before any code is written.

## Non-goals

- #961 is an enhancement (provider custom headers via PATCH), already labeled
  `enhancement` by the triage bot and confirmed unchanged. No code, no relabel.
- #966 stays open with its two surviving falsifications; the author may push
  corrections.
- #907 stays blocked on `lidge-jun/jawcode`; nothing in this unit touches it.
- No push to `dev`, `preview`, or `main`. Layer 7 is a `codex/` branch like the
  rest of the stack.

## Documents

| Doc | Contents |
|---|---|
| `010_nim_vision_classification.md` | #964 reconstruction — the classification design and its diff |
| `020_service_repair_path.md` | #970 reconstruction — call-site inventory and the after-stop safety proof |
| `030_merge_and_close_sequence.md` | bottom-up merge order, retargeting, and issue closure evidence |
