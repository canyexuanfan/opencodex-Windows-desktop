# 120 — Outcome (in progress)

Baseline `origin/dev` = `7c348a032`. This records what has landed so far; the unit is not closed.

## Landed

| Unit | Issue | Merge |
|---|---|---|
| `010` `/api/sync` regression | `#1802` CLOSED | `73440d4bb` |
| `020` latency term | `#1837` CLOSED | `73440d4bb` |
| `030` workspace outcome | `#1789` CLOSED | `73440d4bb` |
| `040` typed cause | `#1784` CLOSED | `73440d4bb` |
| `060` CLI mutation | `#1838` CLOSED | `73440d4bb` |
| `050` quota window (partial) | `#1791` open | `73440d4bb` |
| `070` signature scoping | PR `#1823` | `fe07a1f48` |
| `080` Cursor budget evidence | `#1830` CLOSED | `0313716c2` |
| `090` fallback hop (partial) | `#1524` open | `8f7a22ff7` |
| `100` admission source + substitution (partial) | `#1686` open | `798ecbfb7` |

## Corrections the audits forced on the roadmap

The source roadmap was written against a snapshot taken mid-run, so it was stale in both directions. Five parallel read-only audits established:

- **Named but absent:** `materializeCodexUpstreamAuth`, `CatalogConvergenceError`, the snake_case replay keys (`provider_family` / `route_account_key` / `conversation_root_key` / `model_key`), a unified `clean|routed|recoverable|ambiguous|invalid` home classifier, `adoption-pending` in runtime, and `context_window_too_small` / `modality_unknown` / `compatible_fallback`.
- **Present but missed:** `mutatePersistedConfig` (so `#1835` needed no new primitive), `saveConfigPreservingClaudeCode`'s three-way merge, `OcxReasoningReplayIdentity` (so `#1823` needed no SQLite schema), and real latency measurement already inside `healthScore()`.
- **Wrong in substance:** the roadmap's central security claim. An admission secret cannot reach an upstream on a non-forward path at this SHA — Direct rejects a recognized proxy bearer before upstream auth resolution, pool/main-pool overwrite it, and non-forward adapters install their own credential. `#1686`'s real defect is the inverse: the proxy REFUSED the intended flow.

## Plan-review findings (3 rounds, 15 corrections)

The decade docs were themselves wrong in ways that would have produced uncompilable or vacuous work:

- `060`'s callback used `Object.assign`, which cannot remove a key — `unset` would have reported success while changing nothing. Confirmed by driving it red during implementation.
- `030` assumed the 403 body was already parsed; at `7c348a032` that branch returns without reading it, so the denial parser had to be written, not threaded.
- `040` proposed forwarding a redacted `Error.message`; `redactSecretString` masks token shapes but not paths, homes or account ids, so both cause fields became closed vocabularies.
- `050` required `limit_window_seconds`, which older WHAM payloads omit, and used a singular governing window where `#1791`'s own case has two.
- `090` cited an estimator that needs a model id at a point where no model is chosen, and ignored `ADMISSION_TOLERANCE = 2.5`.
- `020`'s snippet referenced a `candidate` variable that does not exist at the evaluator's scoring site.

## Implementation findings

- **`#1823` emit-before-persist is real but narrower than reported.** `response.output_item.added` is emitted before the store is touched at all; the terminal item is emitted after the in-memory write but without awaiting durability. Both are addressed; the entry cap was also not a memory bound (64KiB signatures × 16,384 ≈ 1GiB), so a byte cap was added.
- **`#1524` is not a missing check.** `checkInputAdmission` already refuses an oversized request before upstream I/O. The defect is that its 413 was classified `request_too_large`, which `comboFailureDecision` treats as `stop`, so the first incompatible candidate ended the chain. A distinct `input_admission_refused` code is now hop-eligible while upstream `context_length_exceeded` still stops.
- **`#1830`'s mechanism is the byte budget.** Turning deferred discovery off pushes the nested MCP catalog into `exec.description`; the added tests measure that on the real protobuf serializer rather than asserting the flag.
- **`#1686` required widening admission and guaranteeing substitution TOGETHER.** Relaxing `validateForwardAdmissionCredential` alone would have created the leak it prevents.

## Verification

Every merge had exact-head CI green apart from the macOS job, which is queued rather than failing.

Remote Linux suite at `798ecbfb7` (the current `dev` head): **12684 pass / 15 skip / 16 fail**. The only
branch-vs-baseline difference is a `bun`-not-on-PATH harness case, so there is no regression.

One process note worth keeping: an earlier run of that suite reported two extra failures purely
because the remote checkout was sitting on a different commit. Verify `git log --oneline -1` on the
remote before reading a suite result as evidence — a stale checkout produces a confident wrong answer.

## Remaining

- `#1686` second half: thread the admission through HTTP/compact/Chat handlers so Direct substitutes end to end, and emit modern `env_key` from injection.
- `101` `#1049` legacy Codex home adoption.
- `102` `#1798` restore three-way semantic merge.
- `#1791` generic quota-window storage; `#1524` full capability preflight.
- `#1795` stays open pending a live SenseNova/Kimi reproduction.


---

# Continuation record — Wave 3/4 second pass

Written after the merge of `#1861` and `#1862`. The table in the section above covers the
first pass; this records what the continuation established.

## Landed in this pass

| Unit | Issue | PR | State |
|---|---|---|---|
| `100` admission threading (second half) | `#1686` | `#1861` | merged, issue CLOSED |
| `102` restore after app rewrite, config + catalog | `#1798` | `#1862` | merged, issue CLOSED |
| `050` burst-window retention | `#1791` | `#1863` | open |
| `090` admission-hop ordering | `#1524` | `#1864` | open |

## Findings that changed the work

**`#1686` was two facts that never met.** `DataPlaneAdmission.source` was already resolved at
the door and `materializeCodexUpstreamAuth` already knew how to substitute — but the source
was dropped one frame later, so `resolveResponsesCodexAuth` ran the forward guard against a
bearer it had just admitted. The fix is threading, not new machinery.

**`#1798` was a formatting proxy for an ownership question.** Marker adjacency cannot survive
a reserializing writer. Recording the injected VALUE makes ownership provable from evidence,
and an exact match keeps restore from deleting a user's own gateway. The catalog half was the
same shape one layer down: restore re-resolved its target from the post-rewrite config, so the
file it actually wrote became undiscoverable.

**`#1791`'s first fix created the second defect.** Stopping the 5-hour window from being
mislabeled as weekly was done by DISCARDING it. The issue reports both windows as live upstream
limits, so an account could sit at 100% of its burst quota while opencodex showed a healthy
weekly bar and routed straight into a 429.

**`#1524`'s hop rule existed but never fired.** `comboFailureDecision` tested the generic stop
list before the admission rule, and `classifyError` maps a real 413 admission body to
`context_length_exceeded` — so the request returned `stop` two lines before the rule written to
hop it. The existing test missed this because it used a top-level `{"code":...}` shape, which
classifies to `upstream_error`, misses the stop list, and reaches the rule. The rule looked
alive while the shape the proxy actually emits kept stopping.

That last one is the ablation lesson of this pass: disabling the structured-code arm alone
still passes, because a `message.includes` fallback catches it. Only the ORDERING ablation
fails. An ablation that does not fail has not proven the mechanism it was aimed at.

## Deferred with recorded evidence

- **`#1049`** — corrected plan in `101`. The original was uncompilable in two places and
  vacuous in one: adoption implemented in `inject.ts` alone is unreachable because
  `withCodexWriteLock` refuses routed residue first, and the proposed "pending row before
  publishing" reintroduces the crash window the archived contract removes. Five files, a
  publication protocol, and a failure mode of an unusable Codex home — not compressible into
  one cycle.
- **`#1795`** — `130`. The guard is a deliberate fail-closed contract; the request is to relax
  it. Silently dropping an undeclared `exec` call trades a visible failure for an invisible
  one, and the correct SCOPE (global / per-provider / subagent-only) is a product decision.
  Evidence requested on the issue.
- **`#1524` remainder** — request context size is still unknown at initial policy evaluation,
  so the chain discovers incompatibility at admission and hops rather than ranking only
  candidates that fit. An optimization of an already-correct chain, not the reported defect.

## Verification

Remote Linux suite (`ssh lidge`, `bun test --isolate tests`), run at each PR head:

| Head | pass | skip | fail |
|---|---|---|---|
| `798ecbfb7` (earlier baseline) | 12684 | 15 | 16 |
| `acfedae0a` (`#1861`) | 12687 | 15 | 16 |
| `6cd5b04b3` (`#1862`) | 12687 | 15 | 16 |

The 16 failures are identical across all three and are `bun`-not-on-PATH harness cases
(`doctor-gui-if-changed`, `lint-gui-if-changed`, the two-process lock contention group, and
the generated-metadata sync check). No regression.

Every merge had exact-head CI green apart from the macOS job, which is queued rather than
failing — the same pattern recorded in the first pass.

