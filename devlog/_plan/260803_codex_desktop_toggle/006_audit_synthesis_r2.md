# Audit round 2 — synthesis, and the replan it forces

Verdict: **FAIL**. Five of eleven closed, six still open, and **six NEW findings**
including three High.

## The number that decides this round

| Round | Closed | Still open | New |
|---|---|---|---|
| 1 | — | — | 11 |
| 2 | 5 | 6 | 6 |

A converging audit closes more than it opens. This one did not. And the new
findings are not nitpicks — they are the same *class* as the old ones, found one
layer deeper:

- round 1 said "persistence is unsafe" → round 2 says the fix drops the
  `authModeMigratedAt` sentinel, so a client toggle silently pins the user's
  Claude auth mode (`src/claude/auth-mode-migration.ts:16-31`)
- round 1 said "in-flight writers can re-enable" → round 2 says teardown callers
  in `src/service.ts:2587-2592` and `management-api.ts:181-186` still bypass the
  flight entirely
- round 1 said "startup must converge" → round 2 says the convergence I added can
  **tear down another installed service's Codex/Grok state** from a different
  `OPENCODEX_HOME`, because the registry calls the removers directly without
  `assertNativeTeardownOwned`

That last one is the tell. My fix for a finding *created a worse defect than the
finding*. And #5 (GUI union ownership) is still open after I explicitly assigned
the shared contract to WP3 — because I put the server contract there and left the
GUI parser unowned.

## Root cause (LOOP-REPAIR-01 → root-cause mode)

Two failed repair rounds on the same failure means stop patching and diagnose.

The diagnosis: **I coupled ten clients into one schema change.** `clientIntegrations`
as a ten-key map forced every phase to touch every client's write path, so each
round of fixes widened the blast radius instead of narrowing it. Codex, Grok,
Desktop, Claude Code and six file clients each have different ownership rules,
different teardown callers, and different migration histories. One map made them
one problem.

The evidence that this is the cause rather than bad luck: **WP2 passed both
rounds untouched.** It is the only phase that changes one thing at one boundary.

## The replan

Return to P (LOOP-REPAIR-01 escalation) with a decoupled map. Not a smaller
objective — the same four deliverables, sliced so each is independently
auditable.

1. **WP2 modality fix ships first, alone.** Clean through two adversarial rounds.
   It fixes a live user-facing failure and depends on nothing here.
2. **WP4 API-keys row ships second, alone.** Never audited as blocking; pure GUI;
   no coupling to the schema.
3. **Desired state is re-scoped to ONE client: Codex.** A `codex` flag, its
   gates, its single-flight, its ownership preflight, its CLI semantics. Not a
   ten-key map. Grok's regression gets its own later phase reusing whatever
   shape survives audit.
4. **Claude Code's gates are left exactly as they are.** Round 1 #1 proved I had
   no business touching that ingress; the amended plan keeps them, and now the
   honest move is to not route them through a new helper at all in this unit.
5. **Desktop moves behind Codex** and is re-audited on its own once the
   one-client shape is proven. The goal explicitly permits an evidenced deferral,
   and round 2 #3 (no coherent rule when a foreign profile is selected) plus #6
   (marker cleanup failure ignored) say it is not ready.

## What carries forward regardless

Verified across both rounds and not in dispute: the native-restore thesis
(`001`), the official standard-mode contract (`002`, re-opened by the reviewer in
round 2), the Grok regression (`003`), and the modality defect (`004`). The
research holds. It was the *phase map* that was wrong, which is exactly what
PHASE-SPLIT-01 exists to catch and what I got wrong by slicing along a schema
instead of along ownership boundaries.

## Carried-forward findings for the re-scoped phases

Every open and new finding stays on the ledger, attached to whichever
single-client phase inherits it:

| Finding | Inherits |
|---|---|
| r1 #5 GUI contract, r2 #1 auth sentinel | the Codex phase |
| r2 #2 ownership preflight in reconciliation | the Codex phase — **blocking** |
| r1 #6/#7 flight + convergence, incl. teardown callers | the Codex phase |
| r2 #4 existing-disabled migration, r2 #5 mutating GET | the file-client phase |
| r1 #8, r2 #3, r2 #6 | the Desktop phase |
| r1 #11 stale citations in `001`/`002` | fix now, in this commit |
