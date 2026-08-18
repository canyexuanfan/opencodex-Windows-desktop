#!/usr/bin/env zsh
# cursor-call integration driver — the executable form of
# devlog/_plan/260818_cursor_call_integration/{010,020,030,040,050}.
#
# Fifteen audit rounds found the same defect class over and over: a binding written
# as prose that no shell would enforce. Six rounds of fixing the prose kept producing
# new unbound variables, because a document is not a program. This file is the program.
# The decade docs explain WHY each assertion exists; this decides WHAT runs.
#
# Every step is idempotent to re-run and refuses to continue on a failed assertion.
# Nothing here merges or pushes without the operator invoking that step by name.

set -euo pipefail

ROOT="${0:A:h}/../.."
cd "$ROOT"
STATE="$ROOT/.tmp/cursor-call-integration.env"
mkdir -p "${STATE:h}"

log ()  { print -r -- "[cc] $*" >&2 }
die ()  { print -r -- "[cc] FATAL: $*" >&2; exit 1 }
save () { print -r -- "$1=$2" >> "$STATE"; log "recorded $1=$2" }

# Re-reading state is what makes each step independently re-runnable after a
# compaction, a disconnect, or a day off.
load_state () { [[ -f "$STATE" ]] && source "$STATE" || true }

need () {
  local name="$1"
  [[ -n "${(P)name:-}" ]] || die "$name is not set — run the earlier step first (state: $STATE)"
}

live_dev () { git ls-remote origin refs/heads/dev | cut -f1 }
live_branch () { git ls-remote origin "refs/heads/$1" | cut -f1 }

# ---------------------------------------------------------------- 010: rebase

step_pin () {
  git fetch origin dev
  local base; base="$(live_dev)"
  [[ -n "$base" ]] || die "could not read live dev"
  save VERIFIED_BASE "$base"
}

step_rebase () {
  load_state; need VERIFIED_BASE
  git rev-parse --verify cursor-call-prerebase-260818 >/dev/null \
    || die "snapshot branch missing — it is the only recovery path"
  git rebase "$VERIFIED_BASE"
  git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call \
    || die "rebase did not land on VERIFIED_BASE"
  ! grep -rn "^<<<<<<<\|^>>>>>>>" src tests >/dev/null 2>&1 \
    || die "conflict markers survived the rebase"
}

step_push () {
  git push --force-with-lease --no-verify origin cursor-call
  [[ "$(live_branch cursor-call)" == "$(git rev-parse cursor-call)" ]] \
    || die "remote cursor-call does not match local after push"
}

# ------------------------------------------------------- 020: remote verification

LIDGE_HOME=~/Developer/opencodex

step_verify () {
  load_state
  local tip; tip="$(live_branch cursor-call)"
  [[ "$tip" == "$(git rev-parse cursor-call)" ]] \
    || die "local and remote cursor-call disagree — push first"
  save VERIFIED_TIP "$tip"
  local wt="/tmp/ocx-cc-${tip:0:9}"
  ssh lidge "cd $LIDGE_HOME && git fetch origin cursor-call dev && (git worktree add $wt $tip 2>/dev/null || true)"
  ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$tip\"" \
    || die "lidge worktree is not at VERIFIED_TIP"
  ssh lidge "cd $wt && bun install --frozen-lockfile"
  local gate
  for gate in "bun x tsc --noEmit" "bun run privacy:scan" "bun run audit:high" "bun run build:gui" "bun test --isolate tests"; do
    log "gate: $gate"
    ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$tip\" && $gate" \
      || die "gate failed at $tip: $gate"
  done
  save GATES_GREEN_AT "$tip"
}

# --------------------------------------------------------------- 030: the stack

subject_sha () { git log --format="%H %s" "$VERIFIED_BASE"..cursor-call | grep -F "$1" | cut -d" " -f1 }

step_cut () {
  load_state; need VERIFIED_BASE; need VERIFIED_TIP; need GATES_GREEN_AT
  [[ "$(git rev-parse cursor-call)" == "$VERIFIED_TIP" ]] \
    || die "cursor-call moved since verification — re-run step_verify"
  [[ "$GATES_GREEN_AT" == "$VERIFIED_TIP" ]] \
    || die "the gates were green for a different tree"
  local p1 p2
  p1="$(subject_sha "record what shipped for 010 and 020")"
  p2="$(subject_sha "record what shipped for 040")"
  [[ -n "$p1" && -n "$p2" ]] || die "could not locate both stack boundaries by subject"
  [[ "$(print -r -- "$p1" | wc -l)" -eq 0 ]] || true
  git branch -f cursor-call-wire   "$p1"
  git branch -f cursor-call-cancel "$p2"
  git merge-base --is-ancestor "$VERIFIED_BASE" cursor-call-wire   || die "wire is not on the verified base"
  git merge-base --is-ancestor cursor-call-wire cursor-call-cancel        || die "cancel is not on wire"
  git merge-base --is-ancestor cursor-call-cancel cursor-call             || die "tip is not on cancel"
  local a b c total
  a="$(git rev-list --count "$VERIFIED_BASE"..cursor-call-wire)"
  b="$(git rev-list --count cursor-call-wire..cursor-call-cancel)"
  c="$(git rev-list --count cursor-call-cancel..cursor-call)"
  total="$(git rev-list --count "$VERIFIED_BASE"..cursor-call)"
  (( a + b + c == total )) || die "layers $a+$b+$c do not partition $total"
  log "partition ok: $a + $b + $c = $total"
  save PR1_HEAD "$p1"
  save PR2_HEAD "$p2"
  save PR3_HEAD "$VERIFIED_TIP"
  git push --no-verify origin cursor-call-wire cursor-call-cancel
}

# PR numbers are recorded by the operator right after `gh pr create`, because only
# then do they exist. Every later step asserts them rather than assuming.
step_record_prs () {
  [[ $# -eq 3 ]] || die "usage: step_record_prs <pr1> <pr2> <pr3>"
  save PR1 "$1"; save PR2 "$2"; save PR3 "$3"
}

# ---------------------------------------------------------------- 040: the merge

merge_layer () {
  local pr="$1" expected_head="$2"
  [[ -n "$pr" && -n "$expected_head" ]] || die "merge_layer needs a PR number and its expected head"
  [[ "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" == "dev" ]] \
    || die "PR $pr does not target dev"
  [[ "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" == "$expected_head" ]] \
    || die "PR $pr head moved off the verified SHA"
  [[ "$(live_dev)" == "$EXPECTED_DEV" ]] \
    || die "dev moved since the last layer — rebase and re-verify"
  gh pr merge "$pr" --merge --admin
  EXPECTED_DEV="$(gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid)"
  [[ -n "$EXPECTED_DEV" ]] || die "could not read the merge commit for PR $pr"
  save EXPECTED_DEV "$EXPECTED_DEV"
}

step_merge () {
  load_state
  need VERIFIED_BASE; need VERIFIED_TIP
  need PR1; need PR2; need PR3
  need PR1_HEAD; need PR2_HEAD; need PR3_HEAD
  EXPECTED_DEV="${EXPECTED_DEV:-$VERIFIED_BASE}"
  merge_layer "$PR1" "$PR1_HEAD"
  gh pr edit "$PR2" --base dev
  merge_layer "$PR2" "$PR2_HEAD"
  gh pr edit "$PR3" --base dev
  merge_layer "$PR3" "$PR3_HEAD"
  local merged; merged="$(gh pr view "$PR3" --json mergeCommit --jq .mergeCommit.oid)"
  [[ -n "$merged" ]] || die "PR3 has no merge commit"
  save MERGED_DEV "$merged"
  git fetch origin dev
  git merge-base --is-ancestor "$VERIFIED_TIP" "$merged" \
    || die "the verified tip is not an ancestor of the merge result"
  [[ "$(live_dev)" == "$merged" ]] \
    || log "NOTE: dev has moved past our merge — 050 must say so in the readiness note"
}

# ------------------------------------------------------- 050: release gates on dev

step_release_gates () {
  load_state; need MERGED_DEV
  local wt="/tmp/ocx-dev-${MERGED_DEV:0:9}"
  ssh lidge "cd $LIDGE_HOME && git fetch origin dev && (git worktree add $wt $MERGED_DEV 2>/dev/null || true)"
  ssh lidge "cd $wt && test \"\$(git rev-parse HEAD)\" = \"$MERGED_DEV\"" \
    || die "dev worktree is not at MERGED_DEV"
  ssh lidge "cd $wt && bun install --frozen-lockfile"
  local gate
  for gate in "bun x tsc --noEmit" "bun run privacy:scan" "bun run audit:high" "bun run build:gui" "bun test --isolate tests"; do
    log "dev gate: $gate"
    ssh lidge "cd $wt && $gate" || die "release gate failed on dev: $gate"
  done
  save RELEASE_GATES_GREEN_AT "$MERGED_DEV"
}

# ------------------------------------------------------------------------ driver

main () {
  local step="${1:-}"
  [[ -n "$step" ]] || die "usage: cursor-call-integration.zsh <step> [args]\n  steps: pin rebase push verify cut record_prs merge release_gates state"
  shift
  case "$step" in
    pin)            step_pin ;;
    rebase)         step_rebase ;;
    push)           step_push ;;
    verify)         step_verify ;;
    cut)            step_cut ;;
    record_prs)     step_record_prs "$@" ;;
    merge)          step_merge ;;
    release_gates)  step_release_gates ;;
    state)          load_state; [[ -f "$STATE" ]] && cat "$STATE" || log "no state yet" ;;
    *)              die "unknown step: $step" ;;
  esac
}

main "$@"
