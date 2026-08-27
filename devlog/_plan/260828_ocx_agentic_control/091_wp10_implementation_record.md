# 091 — wp10 implementation record: closing the gap audit, and two plans it disproved

The wp9 close-out gap audit answered YES to "does a material gap remain in agentic CLI
control of GUI capabilities". This phase closes the findings that could be closed honestly
and moves the rest into wp11 with the reasons written down.

## What shipped

| Finding | Disposition |
|---|---|
| `logout --json` silently no-ops | Fixed: argv parsed before any store I/O, three-way exit taxonomy |
| `doctor --json` silently ignored | Refused with exit 2; skill recipe corrected |
| parity gate one-directional | Fixed: bidirectional with a dated 139-route ratchet |
| 3 GUI verbs missing (oauth logout, codex-app-server, claude desktop status) | wp11 |
| no full-invocation skill oracle | wp11 |
| structured doctor report | wp11 |

## The audit disproved two things I had written

Both are recorded because in each case my reasoning was sound and my conclusion was wrong,
which is the failure mode worth leaving evidence of.

**`removeCredential("--json")` is not harmless.** I checked `store.ts:598`, saw the early
return on an unknown key, and wrote the bug up as a wasted call. But `normalizeAuthStore`
(`store.ts:346-355`) copies *every* top-level key it finds, so a hand-edited, legacy, or
corrupted `auth.json` holding a `--json` key would lose that key's active account -- and the
key itself if it was the last one. The severity moves from cosmetic to credential-destroying
in an unusual but reachable store, and that changed what the regression had to prove: it now
compares the store file byte-for-byte around every malformed invocation, rather than treating
a non-zero exit as evidence nothing was written.

**My proposed allowlist was redundant.** I planned a separate list of internal plumbing for
the reverse parity gate. `ManagementRoute.exempt` already carries a typed `ExemptionReason`
union with a mandatory `why` and, for `deferred-verb`, a required owner and tracked doc that
an existing test verifies. A second list would have duplicated the source of truth.

The audit also corrected my count (206 routes, not 207) and, more usefully, my framing: of
the 139 unexplained routes, 122 paths are already referenced from CLI source and only about
two are plausibly pure plumbing. So this is not 139 things that should never have verbs; it
is ~137 working commands that never declared a capability. That is why the mechanism is a
ratchet rather than an allowlist -- an allowlist says "these are fine", and they are not fine,
they are dated debt.

## Two things deferred, and why that is not a dodge

`doctor --json` cannot be a flag addition. `runDoctor` has no report collection: a
module-level failure bit and ~90 direct `console.log` calls across a 1,309-line surface, and
`dispatch.ts` appends the Codex Log Guard's human output *after* it returns. A JSON print
there would interleave prose and JSON on one stdout, which is strictly worse for a parser than
the ignored flag. So wp10 refuses the flag with exit 2 and a pointer to `status --json` /
`ready --json`, and the skill recipe stops recommending it. A documented flag that does
nothing is the defect; refusing it is not ideal, but it is honest.

The full-invocation skill oracle has nothing to validate against yet. `CAPABILITIES` covers
26 verbs; `registry.ts` holds top-level commands and free-form usage strings; and `--help` is
intercepted at `root.ts:40` before subcommand dispatch, so even a nonexistent subcommand
prints help and exits 0. Promising validation without an oracle would have produced a
hand-maintained subcommand table -- a third drifting source of truth. The real answer is a
declarative command grammar shared by parsing, help, capabilities and skill generation, which
is wp11.

## Verification

- `tsc --noEmit` clean.
- 15 pass in `cli-dispatch` (6 new logout assertions), 13 in `cli-capabilities` (2 new parity
  assertions), 26 across dispatch + skill.
- Red-first, three probes: restoring the original logout runner fails all six new assertions;
  removing one ratchet entry fails the forward gate only; adding an already-covered route
  fails the shrink gate only.
- Behavioural check from the branch rather than the installed binary: `logout --json` exits 2
  (was 0 with a false success), `logout nosuch --json` exits 4 with a JSON not-found envelope,
  `logout foo bar` exits 2, `doctor --json` exits 2 with a pointer to the machine-readable
  alternatives.

