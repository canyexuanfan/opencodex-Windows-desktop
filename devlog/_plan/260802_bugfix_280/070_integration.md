# 070 — Integration: land codex/bugfix-280 on origin/dev + close issues

Date: 2026-08-02. Landing plan for the five fixes (010-050) developed on
branch `codex/bugfix-280` in worktree `/Users/jun/Developer/opencodex-bugfix280`.

## Constraints

- The MAIN worktree (/Users/jun/Developer/opencodex) hosts another active
  session with unpushed local commits and an uncommitted file. Do not touch
  it: all integration happens in the bugfix worktree.
- Push is pre-approved by the owner for this scope: fast-forward only, no
  force, target origin/dev.

## Steps

1. `git fetch origin`; `git merge origin/dev` into codex/bugfix-280.
   Expected touch overlap: devlog dirs (additive), possibly
   src/codex/catalog/sync.ts (incoming #653 Baseten + #763 revert) and
   src/providers/registry.ts. Resolve favoring BOTH changes (our ownership
   filter + their provider additions are orthogonal).
2. Post-merge verification: `bun run typecheck` + focused suites:
   tests/storage-cleanup, storage-policy, codex-catalog,
   codex-catalog-sync-hardening, claude-desktop-cli, claude-management-api,
   relay-eager, bun-stream-caps, passthrough-abort,
   codex-app-server-processes, multi-agent-compat.
3. `git push origin codex/bugfix-280:dev` (fast-forwards only because the
   branch contains origin/dev after step 1). No force.
4. Watch the dev-branch CI run; record per-leg results. The Windows leg is
   the runtime proof for #864 (Bun#32111 stall). macOS leg also carries the
   storage/worker suites.
5. Comment + close issues 858, 855, 859, 864, 857 with the merge SHA and CI
   outcome. #848 stays open (its fix rides PR #861; rebase instruction
   already posted).

## Failure handling

- Non-fast-forward push → stop, report (NEEDS_HUMAN).
- CI leg red in a bugfix area → do NOT close that issue; report and
  investigate as a new work-phase.
