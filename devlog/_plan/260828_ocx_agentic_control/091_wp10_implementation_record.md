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
| `system codex-app-server` missing | Fixed |
| `system codex-restart` missing | Fixed |
| `claude desktop status` missing | Fixed |
| API-backed OAuth logout missing | wp11 (needs live-proxy cache invalidation) |
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

## Two deferrals that hold up, and one that did not

A later audit accepted the two below and rejected a third I had bundled with them. That third
one is in the second-round section further down; recording the split here so this section is not
read as a clean bill of health.

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

## Second audit round: my own fix was incomplete, and one deferral was a dodge

A verification audit of the first wp10 commit returned FAIL. It was right on all three counts,
and two of them are about the fix I had just written and verified.

**The flag guard was the same defect one dash shorter.** I wrote `arg.startsWith("--")` and
tested `--json`, `--wat`, and extra positionals. `-j` was still accepted as a provider name, so
with a `-j` key in the store the command deleted a credential and exited 0 -- the exact
behaviour the commit claimed to have eliminated. The lesson is narrow and worth keeping: I
tested the reported input rather than the input class. Any leading dash is now an option.

**The non-mutation regression was vacuous, and I found that one myself.** It compared
`auth.json` before and after; the sandbox home has no `auth.json`, so both sides were null and
the assertion would have passed even if the store had been written. Found by probing the
sandbox rather than re-reading the test. Every case now seeds a credential first, and the audit
then pushed it further: seeding only `claude` cannot detect a bad `removeCredential("--json")`,
because removing a key that is not there leaves the file byte-identical. The cases now seed a
**sentinel credential under the malformed token itself**.

**The preflight could claim credit for someone else's removal.** `getAccountSet` then
`removeCredential` is not atomic: `mutateStore` serializes writes, so two concurrent logouts
both saw a credential and both exited 0. `removeCredential` now returns its disposition from
inside the mutation. This is a smaller false success than the flag bug but the same species,
and it is the kind that only appears under concurrency -- so it would have read as a flake.

**One deferral was scope-dodging.** I had deferred all three missing GUI verbs together. Two
were nearly free: `system` already wraps `runtimeRequest` and the endpoints already return
complete DTOs, so `codex-app-server` and `codex-restart --yes` are branches; `claude-desktop.ts`
already imports `runtimeRequest`, so `status` is one action. Bundling them with the genuinely
hard OAuth-logout case let a cheap gap ride along behind an expensive one. All three shipped;
only API-backed OAuth logout remains deferred, and that one needs atomic disposition plus the
five live-proxy cache invalidations.

**The skill overclaimed.** `SKILL.md` said "Everything the dashboard can do, the CLI can do"
while 136 routes had no declared capability. That is worse than a documentation nit: an agent
that believes the index is exhaustive stops looking after `capabilities --route` returns empty,
and `ocx access key` works. It now states that the index is authoritative for what it lists,
that a verb can exist without appearing there, and that `ocx <group> help` is the fallback.

The ratchet went 139 -> 136 on its first real test, and the shrink-only assertion is what
forced the edit instead of letting the list quietly go stale.


## Verification

- `tsc --noEmit` clean.
- 57 pass across `cli-dispatch` (20, of which 11 are new logout assertions), `cli-capabilities`
  (2 new parity assertions), `skill-ocx`, and `management-route-registry`.
- Red-first, five probes, each failing only what it should: restoring the original logout runner
  fails all six first-round assertions; restoring `--`-only flag detection fails the short-flag
  sentinel case alone; restoring the read-then-remove preflight fails the concurrency case alone;
  removing one ratchet entry fails the forward gate; adding an already-covered route fails the
  shrink gate.
- Behavioural checks run from the branch rather than the installed binary, after an early probe
  used the released `ocx` and reported a stale "Unknown command" that was not evidence:
  `logout --json` exits 2 (was 0 with a false success), `logout -j` exits 2 (was 0 **and
  deleted a credential**), `logout --json=true` exits 2, `logout nosuch --json` exits 4 with a
  JSON not-found envelope, `logout foo bar` exits 2, `doctor --json` exits 2.
- Verified live against the running proxy: `system codex-app-server --json` returns app-server
  state, `system codex-restart` without `--yes` exits 2, `claude desktop status --json` returns
  the applied/desired DTO.
