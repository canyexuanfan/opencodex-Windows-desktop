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

