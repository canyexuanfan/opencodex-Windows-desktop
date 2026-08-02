# 007 — Execution method change (LOOP-REPAIR-01)

P-phase amendment, adopted after the A-gate loop hit its repair bound. This
document changes *how* the roadmap is executed. It does not change what the
feature does; `002`-`006` still govern that.

## 1. What went wrong

Five audit rounds, and the failure mode converged:

| Round | Blockers | Nature |
|---|---|---|
| 1 | 8 | genuine cross-phase contract drift |
| 2 | 4 | disclaimers instead of edits; two real design faults |
| 3 | 6 | four real logic faults, two transcription |
| 4 | 6 | two design, four transcription |
| 5 | 4 | **two design, two transcription** |

The design faults were worth every round — restore adopting unowned entries,
compensation losing prior ownership, an unreadable file read as absent, a
stale refresh orphaning fragments, HTTP mapping swallowing recovery data.
Those are bugs the audit caught *before* a single line shipped, which is
exactly what an A-gate is for.

The transcription faults are different, and they are structural: a mismatched
import, a type declared in one block and used differently in another, a body
that says `/* … */`. **No tool in this repository can see them**, because they
live in fenced code inside markdown. `bun run typecheck` typechecks `src/`; it
has no opinion about a doc. So each round I fixed them by hand, by eye, and
each round produced a fresh crop.

Writing a compiler-checkable artifact without a compiler is the wrong shape of
work. That is the root cause; the remaining transcription defects are its
symptoms.

## 2. The change

**The roadmap stops carrying full implementation bodies. The repository
carries them, and `tsc` checks them.**

What each decade doc must still carry — unchanged, and audited as before:

- exact file list with NEW/MODIFY per path;
- the canonical contracts (`006`) they implement;
- **exported signatures and type declarations** — the cross-module surface,
  which is where every genuine drift actually happened;
- mechanical move instructions with source line numbers, for extractions;
- the activation table: every conditional branch, its trigger, its observable
  proof;
- exact test filenames and test names;
- accept criteria a reviewer can check mechanically.

What they no longer carry:

- complete function bodies, component bodies, or route handlers as
  paste-ready markdown. Where a body is subtle (the classifier's ordering,
  the compensation sequence, `renderYaml`'s quoting), the doc states the rule
  and its proof obligation in prose plus a **short** illustrative excerpt —
  not a transcription of the whole file.

## 3. Why this is not scope reduction

DIFFLEVEL-ROADMAP-01 asks for a plan precise enough to execute without
invention. Precision lives in contracts, signatures, activation proofs, and
tests — all retained. A hand-copied body adds no precision a signature plus a
named test does not, and it adds a defect class the toolchain cannot see.

The evidence is in the audit ledger above: **every genuine design fault was
found in a contract or a rule, and every transcription fault was found in a
body.** The bodies were not paying for themselves.

## 4. How each B phase now runs

1. P re-verifies that phase's doc against the current tree (unchanged).
2. B writes real files in `src/`, `gui/`, `tests/`.
3. **`bun run typecheck` runs before the phase's first commit**, and after
   every subsequent step. A cross-module mismatch is caught in seconds by the
   tool built for it.
4. The phase's focused tests are written from the activation table and run
   green.
5. C runs the phase's full gate; the A-gate reviewer audits the **diff**, with
   `tsc` output as evidence, instead of auditing prose about a diff.

## 5. Disposition of the existing body docs

`011`, `021`, `031`, `061` keep their value as **reference drafts**: they were
written against the real contracts and they encode a lot of thinking. They are
demoted from "paste this" to "this is the intended shape; write it against the
compiler." Their headers say so. Their activation tables and test lists are
promoted into the decade docs' accept criteria, where they were always the
load-bearing part.

The known transcription defects in them (`config-io.ts` split incomplete,
`JournalEntry.priorRecord` missing from the WP2 body, `parseConfig` declared
twice) are therefore no longer blockers to fix in markdown — they are notes
the implementing phase resolves at the keyboard, with `tsc` confirming. Each
is listed in §6 so nothing is lost.

## 6. Carried-forward implementation notes

| Note | Phase | Resolution at the keyboard |
|---|---|---|
| `config-io.ts` owns `parseConfig`, `loadTarget`, `defaultIntegrationIO`; `state.ts` and `merge.ts` import them | WP2 | `tsc` fails if either redeclares |
| `JournalEntry` must carry `priorRecord: OwnershipRecord \| null` | WP2 | `tsc` fails at every WP3 call site otherwise |
| HTTP failure mapping routes by `reason`, never `state` | WP4 | route test asserts `write_failed` in a `conflict` state still yields `integration_mutation_failed` with recovery fields |
| Prune failure is structured, marked, retried, and surfaced as `retentionDegraded` | WP2 | test per 006 §5 |
| `model-rows.ts` is a verbatim cut of `model-routes.ts:114/129/182` | WP1 | existing client-config route test must pass unchanged |

## 7. Goalplan effect

No work-phase is added or removed; WP0's deliverable changes from "decade docs
with full bodies" to "decade docs with contracts, signatures, activation
tables, and tests." The criterion `c-docs` is amended accordingly, and
`c-gates` gains "typecheck runs before each phase's first commit."
