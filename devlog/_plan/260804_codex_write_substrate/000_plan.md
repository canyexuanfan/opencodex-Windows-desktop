# A Codex write path that can be safely interrupted

The prerequisite three integration switches are blocked on.

## Why this unit exists

`../260803_codex_desktop_toggle/` shipped two deliverables and proved the switch
itself is cheap: `ocx restore` already returns Codex to its native path without
stopping the proxy. Then two audit rounds on the durable-OFF flag failed, and the
diagnosis in that unit's `008_audit_synthesis_wp4_r2.md` was not the flag:

> Codex's write path was never designed to be interrupted.

Every attempt to add "check the flag before writing" hit the same wall. A check
is not a lock; the catalog refresh cannot be split around one; the history write
would freeze the proxy for every other client if a lock were held across it; and
the ownership guard that was supposed to protect a foreign home fails open, after
the artifacts it guards have already been created.

So this unit builds the substrate. **It ships no switch.** The switches
(`WP4`/`WP5` Codex, `WP6` Grok, `WP7` Desktop in the prior unit) become small
once it exists.

## The four parts, and why they are ordered this way

Dependency order (PHASE-SPLIT-01), not effort. Each phase closes with something
independently verifiable.

| Phase | Doc | Delivers | Depends on |
|---|---|---|---|
| WP9 | `010_catalog_seam.md` | `gatherCodexCatalogCandidate` / `commitCodexCatalogCandidate` + a typed outcome | — |
| WP10 | `020_history_isolation.md` | history off the server event loop, fail-fast under convergence | — |
| WP11 | `030_lock_protocol.md` | the async per-home lock with a hardened namespace | WP9, WP10 |
| WP12 | `040_ownership_convergence.md` | tri-state authority, admission order, absence restoration | WP11 |

WP9 and WP10 are genuinely independent: one makes catalog work *splittable*, the
other makes history work *non-blocking*. Neither needs a lock to be useful, and
both must exist before a lock is worth taking — a lock around an unsplittable
gather-and-write, or around a ten-second blocking history call, is the failure
the last unit already proved.

WP11 then has something bounded to wrap. WP12 sits last because the admission
order it defines must run *before* the lock module creates anything, so it needs
the lock's real construction sequence to point at.

## Research, all written this cycle

- `001_catalog_seam.md` — the gather/commit line drawn through `refresh.ts`, all
  16 management callers traced, and the stale-candidate problem named
- `002_history_off_the_loop.md` — every blocking operation mapped, server-process
  vs CLI-process callers separated, worker isolation + fail-fast recommended
- `003_lock_protocol.md` — async SQLite lock, `acquired | busy | refused`,
  barging-allowed, per-user namespace under the real home, realpathed key
- `004_ownership_and_convergence.md` — four independent vetoes in one admission
  order, provenance by baseline-absence ledger rather than filename, and why
  `unchanged` must still converge

Carried forward from the prior unit: all eleven open findings listed in
`../260803_codex_desktop_toggle/008_audit_synthesis_wp4_r2.md`. Each is assigned
to a phase in the table above and re-stated in that phase's decade doc.

## Scope boundary

IN: `src/codex/**`, `src/server/management/context.ts` and its callers,
`src/config.ts`, `src/service.ts`, `src/integrations/native/**`, `tests/`,
`docs-site` lifecycle and configuration pages, this unit.

OUT: the GUI switches (they follow once this lands), `gui/**`, releases,
publishing, deploys, tags, npm, starring the repository. The six file clients
remain `FOLLOWUP-FILECLIENT-01` from the prior unit.

## Criteria

- C1 — catalog work gathers outside a lock and commits inside it, and a failure
  is a typed outcome rather than a swallowed exception.
- C2 — a stale candidate cannot be committed: a config or base-catalog revision
  change between gather and commit is detected and refused.
- C3 — a dashboard-initiated OFF never blocks another client. Measured, not
  argued: `/healthz` stays responsive while real SQLite history contention is
  active.
- C4 — history that cannot be resolved is recorded as unresolved and retried,
  never silently reported as success.
- C5 — lock acquisition is async with a finite deadline and returns
  `acquired | busy | refused`; contention is never an exception.
- C6 — two spellings of the same home take the SAME lock; two different homes
  never do. Symlinked, default, explicit and case-differing spellings all tested.
- C7 — the lock namespace is per-user, outside `CODEX_HOME`, and rejects a
  symlinked or wrong-owner path rather than trusting it.
- C8 — automatic convergence refuses on `foreign` AND `unknown` ownership, and
  creates no artifact — no lock file, no database, no journal write — before the
  answer is known.
- C9 — the external-`model_provider` guard survives as an authority distinct from
  service-home ownership.
- C10 — an artifact that did not exist before apply is *removed* on convergence,
  not merely filtered; and a baseline-absent artifact the user has since edited is
  preserved with a reported conflict rather than deleted.
- C11 — `unchanged` desired state still converges observed state.
- C12 — a desired-state change made by another process is honored by the running
  server without a restart.
- C13 — typecheck, full test, gui lint, privacy scan green; no regression in the
  8000-test suite.

## Risk register

| Risk | Mitigation |
|---|---|
| A lock held across unbounded work freezes the proxy | WP10 lands before WP11; the locked section is synchronous and bounded by construction, and C3 measures it rather than asserting it |
| The substrate becomes a fifth concurrency pattern | `003` catalogues the existing `withConfigMutationLockSync` and `runIntegrationMutationFlight` and states where the new lock deliberately differs |
| Deadlock against the config mutation lock | One stated ordering, plus a proof that no inverse nesting exists today |
| Convergence deletes something the user owns | Provenance is a recorded baseline-absence plus post-image hash, never a filename or marker; on conflict, preservation wins and the operation reports rather than deletes |
| Another round of divergence | One phase, one boundary, one audit. WP2 and WP3 of the prior unit passed clean on exactly that property; WP4 failed twice without it |

## What this unit does not claim

It does not make Codex's write path transactional. A crash mid-commit still
leaves partial state; what changes is that the partial state is *detectable* and
the next convergence *re-runs* against it. `004` §Artifact inventory is explicit
about which artifacts can be restored to absence and which can only be reported.
