# 050 — WP5: docs-site troubleshooting page + invariant sweep + full gates

Depends: WP1-WP4 landed.

## NEW docs-site page

Path: docs-site/src/content/docs/troubleshooting/windows-memory.md (verify the
actual troubleshooting collection path at WP5's P; follow existing frontmatter
conventions of sibling pages; English source of truth — translated locales NOT
updated here, only checked for non-contradiction).

Content contract (honesty labels from 001 §6 — MUST appear verbatim in spirit):
1. Symptom: growing RSS of the `bun` process on Windows (#314 shape).
2. Root cause: upstream Bun runtime issues — fetch backpressure (#28035, fixed
   via #29831, release inclusion unverified), async-pull cancel crash (#32111,
   fix merged, release inclusion unverified), node:net handle leak (PR #31654
   still open). Bundled runtime is 1.3.14.
3. What opencodex does today: bounded mitigation only — RSS watchdog warnings,
   `ocx doctor` memory section, `/api/system/memory`; the leak itself is NOT
   fixed on the bundled runtime. Real-world RSS relief: awaiting Windows user
   verification.
4. Options: (a) wait for a bundled runtime bump; (b) OPENCODEX_BUN_PATH
   override with a runtime you trust (unvalidated, own-risk label);
   (c) config `streamMode: "eager-relay"` opt-in — explicitly labeled with the
   #32111 crash risk on 1.3.14.
5. Threshold auto-restart: NOT shipped (deferred; F4). Service-manager respawn
   (WinSW/launchd/systemd) already restarts on crash-exit.
6. Link from an existing troubleshooting index/sidebar if one exists.

## Invariant sweep

- Re-verify tests/passthrough-abort.test.ts + index.ts mirror comment coherence
  after all phases (H4/F5).
- Re-verify crash-guard comment rationale (A6).
- rg for stale references: "no-tee", dead flags, TODOs left by WP1-WP4.
- structure/ notes: if structure/ has a server/streaming invariant doc, append
  the two-shape contract (check at WP5 P; SOT-SYNC-01).

## Final gates (goalplan c-gates)

- bun run typecheck; bun run test; bun run privacy:scan; bun run lint:gui only
  if gui touched (should be NO).
- docs-site build check: bun/astro build for docs-site if a script exists
  (check package.json at WP5 P) — else markdown lint by inspection.
- Goalplan: all criteria capturedEvidence filled; ledger updated; final commit.
