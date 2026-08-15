# 020 - Merge execution record (wp2-wp3)
 
## Plan (written at P, verified: zero head drift on all 15 PRs, 2026-08-15)
 
Mechanism: local integration branch with --no-ff merges of pull/<n>/head refs,
so each PR head becomes an ancestor of dev and GitHub auto-marks the PR Merged
on push (preserves contributor attribution, e.g. external #1716). One dev push,
one dev CI run, one lidge validation before the push.
 
### Step 1 - retarget stacked children to dev (gh pr edit --base dev)
 
- #1706 (was cl10-public-core), #1722 (was refactor/adapter-registry-authority),
  #1723 (was test/adapter-registry-conformance).
 
### Step 2 - integration branch
 
git fetch origin
git switch -c int/260815-pr-landings origin/dev
 
Merge order (dependency-safe):
1. #1708 #1709 #1710 #1712 #1715 #1717 #1719 #1720 (independent lab fixes)
2. #1705 then #1706 (stack; #1706 branch contains #1705)
3. #1714 (endpoint guard)
4. #1721 (authority test fixture fix required: tests/adapter-registry-authority.test.ts
   mimo-free provider baseUrl example.invalid/v1 -> canonical MIMO_CHAT_URL
   https://api.xiaomimimo.com/api/free-ai/openai/chat; separate fix commit)
5. #1722 then #1723 (stack; contains #1721)
6. #1716 (external feature, disjoint files)
 
Each: git merge --no-ff FETCH_HEAD -m 'Merge PR #<n>: <title>' using
git fetch origin pull/<n>/head.
 
### Step 3 - devlog unit onto int
 
Cherry-pick 1628d06c2 (triage docs) onto int.
 
### Step 4 - validate
 
git push origin int/260815-pr-landings
ssh lidge: clone/fetch, checkout int branch, bun install, bun run typecheck +
bun run test (+ privacy:scan). Suite runs ONLY on lidge per owner directive.
 
### Step 5 - land
 
git push origin int/260815-pr-landings:dev --no-verify
(owner-authorized; enforce_admins=false so admin bypass works on protected dev)
Then verify all 15 PRs auto-marked Merged; stragglers get an evidence comment
and manual close.
 
### Step 6 (wp3) - KEEP-DRAFT comments
 
Brief maintainer comment on #1704 #1718 #1725 #1727 #1728 #1729 #1732 naming
the recorded gaps (010 matrix).
 
## A-audit amendments (GO-WITH-FIXES, 3 blockers folded)
 
1. #1709 -> #1706 semantic conflict in src/lab/ledger/purge.ts: #1706's export-purge steps + deferred-error vars must be re-expressed inside #1709's withLedgerMutation wrapper. Pre-staged resolution; purge tests re-run.
2. #1715 -> #1714 trivial conflict in gui/.eslint/i18n-allowlist.ts: take #1714's /^HTTP$/i version (superset).
3. Fixture fix covers THREE files (mimo-free canonical /chat under #1714's guard): tests/adapter-registry-authority.test.ts (#1721), tests/adapter-tool-conformance.test.ts (#1722), tests/adapter-buffered-tool-conformance.test.ts (#1723). Separate commits, never amend PR heads (auto-merge detection is exact-SHA).
4. Advisory: retargets before push; re-verify all 15 head SHAs at push time.
 
## Execution log
 
(pending)
 
