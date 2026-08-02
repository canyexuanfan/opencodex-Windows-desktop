# 007 — Roadmap verification tooling (LOOP-REPAIR-01)

P-phase amendment, adopted after the A-gate loop hit its repair bound.

**This document does NOT relax DIFFLEVEL-ROADMAP-01.** An earlier draft of it
tried to, by declaring that decade docs need only carry contracts and
signatures. The A-gate was right to reject that: the rule is STRICT and asks
for copy-paste-executable bodies, and a unit-local doc cannot redefine a
governing gate. That draft is withdrawn.

The bodies stay. What was missing was not a lower bar — it was a **compiler**.

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

## 2. The fix: give the roadmap a compiler

`tools/check-blocks.ts` (new, lives with the unit it verifies) extracts every
fenced `ts`/`tsx` block from the unit's numbered docs, classifies it, and
writes the compilable ones to `.blocks/` for `tsc`:

```
bun devlog/_plan/260802_client_toggle_api/tools/check-blocks.ts
cd devlog/_plan/260802_client_toggle_api/.blocks
bun x tsc --noEmit --skipLibCheck --strict --noResolve \
  --target esnext --module esnext --moduleResolution bundler --jsx react-jsx *.ts *.tsx
```

Classification matters, because not every fenced block is a compilation unit:

| Class | Treatment |
|---|---|
| unit (top-level decl, balanced braces) | compiled |
| diff (`+`/`-` markers) | counted, not compiled — it is a patch, not TypeScript |
| fragment (mid-function excerpt) | counted, not compiled |
| **placeholder** (`/* … */`, `/* moved verbatim */`) | **reported by path and line** — a body we did not write cannot pass silently |

`--noResolve` is deliberate: each block is checked as a self-contained unit for
syntax and internal consistency. Cross-module identifier resolution belongs to
the implementing phase, where the real imports exist and the repository's own
`bun run typecheck` covers it.

## 3. What it caught immediately

First run over 19 docs / 79 blocks: 73 compilable units, 5 fragments, and
**1 placeholder** (`011:73`) plus **1 syntax error** — the `ctx: {...}`
pseudo-signature still sitting in `030`, which four rounds of human review had
walked past. Fixed in the same pass; the suite is now clean.

That is the entire argument for this tool in one data point: the design faults
across five rounds were all caught by review, and the transcription faults were
all invisible to it.

## 4. When it runs

- **Now**, and after any edit to a decade doc: the placeholder count must be
  0 and `tsc` must be clean before the roadmap re-enters the A-gate.
- **At each phase's P**, as part of the stale check.
- **At each phase's C**, alongside the repository gates, so a doc amended
  during B cannot drift from the code it describes.

DIFFLEVEL-ROADMAP-01 is satisfied in its own terms: every decade doc still
carries exact paths, NEW/MODIFY, real signatures, and copy-paste-executable
bodies — and now the bodies are checked by a compiler instead of by eye.

## 5. Carried-forward implementation notes

These were found by review and are fixed in the docs; the checker guards
against their reintroduction:

| Note | Phase | Guard |
|---|---|---|
| `config-io.ts` owns `parseConfig`, `loadTarget`, `defaultIntegrationIO`; `state.ts` and `merge.ts` import them | WP2 | duplicate declaration shows as a redeclaration error |
| `JournalEntry` carries `priorRecord: OwnershipRecord \| null` | WP2 | missing property errors at every construction site |
| HTTP failure mapping routes by `reason`, never `state` | WP4 | route test asserts `write_failed` in a `conflict` state still yields `integration_mutation_failed` with recovery fields |
| Prune failure is structured, marked, retried, surfaced as `retentionDegraded` | WP2 | test per `006` §5 |
| `model-rows.ts` is a verbatim cut of `model-routes.ts:114/129/182` | WP1 | existing client-config route test must pass unchanged |

## 6. Goalplan effect

No work-phase is added or removed and no deliverable is weakened. `c-docs`
keeps its meaning; `c-gates` gains "the block checker reports 0 placeholders
and clean `tsc` before each A-gate and at each phase's C."
