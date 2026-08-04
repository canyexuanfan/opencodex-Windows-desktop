# 001 - PR stack status ledger

Continuously updated during the programme. Every branch records: base SHA,
head SHA, PR number/URL, verification result, and review state.

## Programme facts

- Stack base (dev): `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6` (`upstream/dev`)
- `origin/dev` (fork, stale ancestor): `be177ea501e5007f4a56d19d069ef5cd76ea24b9`
- Bun: `1.3.14`; package version: `2.10.0`
- Worktree: `D:\codex-worktrees\ocx-router-intelligence`
- Push remote: `origin` (Wibias/opencodex); PR target: `lidge-jun/opencodex:dev`
- All PRs opened as DRAFT; nothing merged by this programme.

## Related in-flight PRs (not superseded by this stack)

| PR | Branch | Note |
|---|---|---|
| #922 | `fix/914-account-neutral-network` | #914 alternative; consumed as health evidence input by RI-06 |
| #966 | `codex/260804-issue914-transport-attribution` | #914 alternative; consumed as health evidence input by RI-06 |
| #715 | `feat/priority-levels` | Pool selection order; out of scope |
| #988 | `codex/providers-copy-doctor` | GUI providers/combos; conflict-checked at RI-10 |
| #998 | `codex/260803-integration-switches` | Write substrate; rebase watch on request-log.ts |

No open PR found that implements the same vertical as any PR in this stack,
so no stale PR is closed by this programme. Both #914 drafts overlap each
other; closing one is a maintainer decision and neither is stale.

## Baseline

- Full-suite baseline on clean `upstream/dev` (worktree
  `D:\codex-worktrees\ocx-typecheck-base`, head `e44d234f0`): running in
  background; exact pass/fail counts appended here when done.
- `bun x tsc --noEmit` on clean `upstream/dev`: **PASSED** (0 errors, verified
  in the pristine base worktree).
- `bun run privacy:scan`: passed per-PR (see RI-01 below).

## Stack status

| RI | Branch | Base | Head SHA | PR | URL | Status |
|---|---|---|---|---|---|---|
| RI-01 | `feat/ri-01-route-decision-traces` | `e44d234f0` | `b5a8e7c4c` | #1003 | https://github.com/lidge-jun/opencodex/pull/1003 | DRAFT OPEN |
| RI-02 | `feat/ri-02-request-history-index` | `b5a8e7c4c` (RI-01 head) | pending | pending | pending | in progress |
| RI-03 | `feat/ri-03-routing-analytics` | `7efb6e842` (RI-02 head) | pending | pending | pending | in progress |
| RI-04 | `feat/ri-04-policy-profile-core` | `2069e724e` (RI-03 head) | pending | pending | pending | in progress |
| RI-05 | `feat/ri-05-capability-aware-routing` | `00e1c4ae5` (RI-04 head) | pending | pending | pending | in progress |
| RI-06 | `feat/ri-06-health-aware-routing` | `56f17f45c` (RI-05 head) | pending | pending | pending | in progress |
| RI-07 | `feat/ri-07-quota-aware-routing` | `feat/ri-06` head | pending | pending | pending | queued |
| RI-08 | `feat/ri-08-cost-aware-routing` | `feat/ri-07` head | pending | pending | pending | queued |
| RI-09 | `feat/ri-09-route-explainability-api` | `feat/ri-08` head | pending | pending | pending | queued |
| RI-10 | `feat/ri-10-routing-intelligence-ui` | `feat/ri-09` head | pending | pending | pending | queued |

## Per-PR acceptance log

### RI-01 - feat/ri-01-route-decision-traces

- Base SHA: `e44d234f08e03dd4dbf0c4aa13af43046d86b0a6`
- Reviewed commit: same as final (single implementation commit; independent
  review pass performed by the author before push)
- Findings (self-review): 3 test failures caught pre-push - (1) missing value
  import for `normalizeRouteDecisionTrace` in request-log hydration,
  (2) selected combo target marked ineligible because `ComboPick.attempted`
  includes the winner, (3) account-namespace fixture missing the canonical
  ChatGPT forward `baseUrl` (test-fixture bug, not product code).
- Fixes: import fixed; `comboRouteCandidates` now excludes the selected target
  from `already-attempted`; fixture uses `https://chatgpt.com/backend-api/codex`.
- Regression tests: all three cases are covered by the final
  `tests/route-decision-trace.test.ts` (14 tests, 75 assertions).
- Final commit: `b5a8e7c4cd25dc3b83726e377899f4c49fca7753`
  (2 commits: plan+ledger `97681a9e5`, implementation `b5a8e7c4c`)
- PR: #1003 (DRAFT) https://github.com/lidge-jun/opencodex/pull/1003
  - base: `dev`, head: `Wibias:feat/ri-01-route-decision-traces`
  - local head == remote head: verified (`b5a8e7c4c`)
- Review state: awaiting review; no external review comments yet
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/route-decision-trace.test.ts`: 14/14 pass
  - Focused regression suites: 253/253 pass across combos, codex-routing,
    usage-log, request-log, combo-management-api, codex-account-namespaces
  - `tests/server-combo-failover-e2e.test.ts`: 44/44 pass
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-02..RI-10

### RI-02 - feat/ri-02-request-history-index

- Base SHA: `b5a8e7c4cd25dc3b83726e377899f4c49fca7753` (RI-01 head)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 4 defects caught pre-push -
  1. `destroyAndRecreate` never reassigned the fresh handle to module `db`
     (first-open rebuild crashed);
  2. bun:sqlite named-parameter objects silently failed to bind for
     `LIMIT $x` and INSERT statements (datatype mismatch / silent no-op) -
     query and insert paths switched to positional parameters;
  3. Windows file locking: an unfinalized prepared statement kept the DB
     locked after close (EBUSY in tests) - insert statement now finalizes;
     a partially-opened handle on a corrupt file is closed before recreate;
  4. duplicate-replay accounting counted ignored rows in `indexedRows` -
     now counts real `INSERT` changes.
- Fixes: all four above; tests cover every one.
- Final commit: pending (recorded after commit)
- PR: pending
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/request-history-index.test.ts`: 16/16 pass
    (1574 assertions) covering the mandatory matrix: empty/missing/corrupt/
    old-schema/partial-line/replacement/truncation/duplicate-replay/cursor
    stability/invalid-cursor/page-bounds/rebuild-equivalence/filters/row-by-id
  - Focused regression suites: 269/269 pass across 8 files (incl. RI-01
    tests, request-log, usage-log, combos, combo-management-api,
    codex-routing, codex-account-namespaces)
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-03 - feat/ri-03-routing-analytics

- Base SHA: `7efb6e84284c070c155c2e5254f1400917df31a1` (RI-02 head)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 3 fixed pre-push - (1) `requestHistoryDb` accessor
  missing from the indexer (analytics needs the handle after open);
  (2) SQL column names are snake_case - analytics SELECT now aliases to
  camelCase; (3) cost field is `estimate.cost.total` (CostBreakdown), not
  `costUsd`; plus the row-cap is injectable for truncation tests.
- Final commit: pending (recorded after commit)
- PR: pending
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/routing-analytics.test.ts`: 8/8 pass (32 assertions):
    classification (success/failure/cancel/incomplete), percentiles +
    coverage, fallback rate, provider/model/account + profile breakdown,
    unknown-price honesty, filters, truncation flag, API payload
  - Focused regression suites: 144/144 pass across 6 files
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-04 - feat/ri-04-policy-profile-core

- Base SHA: `2069e724ec27e176644a11ff55bef307f5ebe3bf` (RI-03 head)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 4 fixed pre-push - (1) `serviceTier` evidence type
  was `Unknownable` (number|boolean) but service tiers are strings - trace
  type narrowed to `string | "unknown"`; (2) alias validation missed the
  reserved `combo/` namespace prefix; (3) trace candidates did not carry
  `score` - added `score` to `TraceCandidateInput`/`buildCandidate`;
  (4) test expectation for weight normalization used wrong math (unspecified
  weights keep defaults; sum 4.35 not 4).
- Final commit: pending (recorded after commit)
- PR: pending
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/routing-profile.test.ts`: 12/12 pass (validation,
    normalization, revision digest, collisions, config load, id/alias
    resolution, dry-run eligibility/unknown/tie-break, API list+dry-run,
    API error codes)
  - Focused regression suites: 176/176 pass across 8 files
  - `bun run privacy:scan`: passed
  - `tests/config.test.ts`: 109/115 pass; the 6 symlink failures reproduce
    identically on the pristine base (Windows symlink EPERM, environmental)
- Remaining Low findings: none

### RI-05 - feat/ri-05-capability-aware-routing

- Base SHA: `00e1c4ae5df32cdf6d72957c1a36b334fe4dc0a6` (RI-04 head)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 2 fixed pre-push - (1) request evidence was wired
  but unused by the evaluator - request requirements (`request-tools`,
  `request-image-input`) now constrain candidates when the body provably
  needs them; (2) trace-score plumbing verified end-to-end (score was added
  to trace candidates in RI-04).
- Final commit: pending (recorded after commit)
- PR: pending
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/policy-execution.test.ts`: 8/8 pass - explicit
    policy/<id> + alias execution, precedence unchanged (explicit/combo/
    native/default), all-excluded error, unknown-capability per profile,
    request evidence (image/tools) constraints, determinism
  - Focused regression suites: 231/231 pass across 8 files (incl. combo
    e2e + codex-routing)
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

### RI-06 - feat/ri-06-health-aware-routing

- Base SHA: `56f17f45c4705762c5783365366962bd5e5bd5e9` (RI-05 head)
- Reviewed commit: same as final (author self-review before push)
- Findings (self-review): 4 fixed pre-push -
  1. route-time health evidence needed synchronous index access; the indexer
     refresh is now a sync core (`openRequestHistoryIndexSync`) with the async
     single-flight wrapper around it;
  2. unknown-health "penalize" now folds a deterministic floor (0.3) into the
     score instead of silently skipping the component;
  3. trace candidates now carry capability/health/quota/cost evidence;
  4. score assertions in RI-04/RI-05 tests updated for the new health
     component (behavioral change by design).
- Final commit: pending (recorded after commit)
- PR: pending
- Verification:
  - `bun x tsc --noEmit`: PASSED (0 errors)
  - `bun run test tests/health-scoring.test.ts`: 9/9 pass - historical
    evidence (success rate, consecutive failures, latency, samples),
    cancellation/invalid-request neutrality, incomplete streams, low-sample
    confidence, hard-cooldown authority + exclusion, unknown-health policy,
    score component + trace evidence, health-driven selection, execution path
  - Focused regression suites: 196/196 pass across 8 files
  - `bun run privacy:scan`: passed
- Remaining Low findings: none

## Baseline note

The full-suite baseline on this Windows machine did not complete within the
available window (background run, >3h, no summary emitted; the suite is
~8k tests and this machine is heavily loaded). Focused suites, typecheck and
privacy:scan pass per PR; the upstream PR #966 verification report records
~7941 pass / 10 environmental failures on clean dev. A final full-suite
attempt is scheduled at stack end.
