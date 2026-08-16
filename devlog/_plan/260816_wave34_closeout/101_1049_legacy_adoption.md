# 101 — #1049: adopt pre-substrate Codex homes into the coordinator

One PABCD cycle. Runs AFTER `100` — both touch `src/codex/inject.ts`.

## Verified state

Legacy homes bypass the write lock entirely: injection calls `applyNativeArtifacts()` directly for `legacy-uncoordinated` (`src/codex/inject.ts:901`) and restore calls `restoreCodexConfigInline()` (`:1504`). The eligibility layer says so explicitly (`src/codex/inject-coordination.ts:36`, `:84`), and `tests/codex-inject-write-lock.test.ts:144` currently PINS that bypass.

Already satisfied: residue detection, invalid-record refusal, unversioned/rowless refusal (`src/codex/transition-state.ts:269`, `:288`).

The roadmap's unified `clean/routed/recoverable/ambiguous/invalid` classifier does not exist. What exists is three separate results: residue `clean|residue|indeterminate` (`src/codex/native-residue.ts:46`), integration record `missing|ready|invalid` (`src/codex/integration-record.ts:98`), coordinator `ready|legacy-ambiguous|unavailable` (`src/codex/convergence-types.ts:298`). Adoption eligibility is a FUNCTION of those three, not a fourth enum to replace them.

## Required shape

The `adoption-pending` design already exists in the archived contract (`devlog/_fin/260804_codex_write_substrate/005_contract.md:709`, crash boundary at `:735`) but runtime `transition-state.ts` does not accept that status. Implement it there:

1. Derive adoption eligibility from the three existing classifiers. Routed + no coordinator + valid record + clean-or-explainable residue is adoptable; indeterminate residue or an invalid record refuses.
2. Write a pending adoption row with an exact-byte fingerprint of the artifacts being adopted, BEFORE publishing anything.
3. Publish under the lock, then clear the row.
4. On startup, a pending row whose fingerprint still matches disk is recoverable and resumes; one whose fingerprint does NOT match refuses and leaves the home legacy-operable rather than guessing.

Preserving legacy operability on refusal is the non-negotiable part: a failed adoption must never leave a home that neither the legacy path nor the coordinator will touch.

## Tests

`tests/codex-inject-write-lock.test.ts:144` asserts the bypass being removed — update it. Add per-state fixtures: adoptable home adopts and then uses the lock; indeterminate residue refuses; invalid record refuses; unversioned/rowless database refuses; a kill at each I/O boundary leaves either the pre-adoption state or a resumable pending row, never a half-published home.
