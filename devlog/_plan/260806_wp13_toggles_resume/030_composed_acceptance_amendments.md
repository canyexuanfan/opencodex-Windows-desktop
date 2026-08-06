# 030 — composed acceptance: reduced workstation scope over 050

`devlog/_fin/260804_codex_write_substrate/050_composed_acceptance.md` remains the
source for the harness rules (real child processes, no imported handlers, seeded
temp roots, lock-path preflight/teardown allowlist, no-sleep synchronization) and
the scenario intents. This document fixes its stale RED claims and cuts the scope
to what this session's safety boundary allows. Where they disagree, this wins.

## What changed under the doc (from the WP-A/WP-B audits)

050's "RED today" claims predate the substrate landing and are now largely GREEN:
`withCodexWriteLock` has production callers (`inject.ts:871-956` and the restore
path), the typed acquisition/refusal taxonomy exists (`codex-write-lock.ts:67-125`),
a real two-process contention test exists (`tests/codex-inject-write-lock.test.ts`),
`convergeCodexCatalog` owns the catalog commit, and — new on THIS branch — desired-
state revalidation sits inside all three artifact serializers plus the cache
reacquisition permit, and every sync caller discriminates skips. What remains
unproven is COMPOSITION: that the real entry points, invoked as production
processes, reach those mechanisms rather than writing around them.

## Scope cut (binding, from 000_plan.md r3)

- **IN:** one new `tests/codex-composed-acceptance.test.ts` in the ordinary suite,
  workstation-safe rows only, real spawned `src/cli/index.ts` children and a real
  HTTP server on a temp `OPENCODEX_HOME` per 050's harness rules.
- **OUT:** the disposable-host service class (P09/P10/P18/P34-P36), the
  `scripts/disposable-host/` job, `/healthz`-under-SQLite-contention (scenario C's
  timing bound needs a controlled host), and the full 36-row census. Issue #1048
  STAYS OPEN; the PR references it without a closing keyword and names the rows
  this suite covers versus defers.

## The reduced scenario set

Composed rows chosen to cross module boundaries this branch touched, one case each:

1. **A-reduced — entry-to-funnel for the toggle-relevant rows.** Real child
   invocations of: P02 (`ocx start`, bind port 0, then kill), P04 (`ocx ensure`),
   P05 (`ocx sync`), P07 (`ocx restore`), P08 (`ocx restore back`), P06
   (`ocx sync-cache`); plus HTTP P19 (`POST /api/sync`) and the toggle routes
   (`PUT /api/native-integrations/{codex,grok,claude-desktop}`) against the real
   server. Each asserts the discriminated result contract (applied vs skipped vs
   refused) and, where desired OFF is seeded, that NO codex artifact
   (config/profile/catalog/cache/history) is created or changed — byte-level
   before/after manifest of the temp `CODEX_HOME`.
2. **B-reduced — lost transition at a real entry.** Desired ON; child A enters
   P19-equivalent sync against a held local provider fixture; a second production
   config mutation persists OFF; release; assert A commits nothing and reports the
   discriminated skip. (The WP-B unit test proved this at the injector seam; this
   case proves it through the HTTP entry.)
3. **D-reduced — foreign home creates nothing.** Foreign-ownership evidence seeded
   per 050; invoke P02, P04, P19, P07 as real children; byte manifest asserts zero
   artifacts (lock DB, catalog, cache, config, history) created anywhere under the
   temp root or the case's OS-runtime lock path.
4. **E — same effective user, different env homes, one lock.** As written in 050
   (workstation-safe): child A holds the lock via a held injection; child B with
   different HOME/USERPROFILE but same CODEX_HOME gets typed `busy` naming the same
   lock id; no lock artifact under either fake home.
5. **Grok E2E (from 000_plan.md).** Disable Grok via the real route, then run the
   real `ocx start` startup path (bind port 0) in a child with the persisted
   config; assert the Grok fence stays absent and the startup log/result reports
   the desired-state skip.
6. **Restore truth composed.** With history DB held by a `BEGIN IMMEDIATE` holder
   child, run `ocx restore` as a real child; assert exit code 1, the artifact
   envelope reports history `busy` while config/catalog restored, and a rerun
   after release converges — the original 040 defect, proven at the CLI boundary.

## Harness rules kept verbatim from 050

Temp root via `mkdtempSync`; explicit fake `HOME`/`USERPROFILE`/`CODEX_HOME`/
`OPENCODEX_HOME`; children spawned as `Bun.spawn([process.execPath,
resolve(repoRoot, "src/cli/index.ts"), ...])`; servers on port 0 with `/healthz`
PID verification; local provider fixtures only; sentinel-based synchronization
(no sleep-as-readiness); watchdogs per child; lock-path preflight requires the
case's hash-derived DB absent, teardown removes only the four-name allowlist
after identity recheck; a teardown failure fails the case. The suite must pass
inside `bun scripts/test.ts` on this workstation without touching the real homes
or the live proxy.

## Proof rule

Each scenario names its RED condition (mutate the mechanism it proves — e.g.
remove a revalidation, point a caller past the funnel — and the case must fail).
At least one broken-change demonstration is executed and recorded for the suite
as a whole before D closes.
