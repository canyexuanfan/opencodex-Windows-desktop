# 001 — Root-cause delta: what wave 1 already landed vs what remains

Date: 2026-08-02. Basis: three read-only explorer passes over `codex/wt2-zero-leak-impl` @ `478354ee8` (= dev tip), plus `gh pr diff` for #840-#847. This doc SUPERSEDES the assumptions in `000_plan.md` where they conflict.

## Wave-1 landings (already on dev, do NOT re-implement)

| Commit | What landed |
|--------|-------------|
| `77243d932` | app-owned retained-state byte budget framework (`src/lib/app-owned-memory.ts`: 256 MiB eviction target, 512 MiB worst-case pinned ceiling, category-ordered eviction, re-snapshot-after-evict honesty) |
| `d1408b92f` | Responses continuation hard cap + durable spill (`src/responses/state.ts`, `src/responses/spill-store.ts`) |
| `034d320b8` | byte caps for blob, replay, vision, image caches |
| `a61607894` | translator turn budgets: 2 MiB/tool call, 32 MiB/turn, 32 MiB SSE logical event (`src/lib/translator-budget.ts`) |
| `17faddd24` | benchmark gap closure |

Framework note (`src/lib/app-owned-memory.ts:43`): the budget is an eviction target, not an admission boundary — it runs AFTER an owner allocated, cannot prevent a single oversized allocation, sees only owner-reported bytes, and cannot evict pinned state. Per-store admission caps remain necessary. That is the frame for every delta below.

## True remaining deltas (the actual work of this unit)

### #841 — Responses state: admission boundary, not rejection (refinement, NOT wave-1 redo)

Current: `setResidentEntry()` (`src/responses/state.ts:243`) fully materializes + measures the candidate, inserts it as resident, THEN prunes — an oversized candidate is fully allocated and older UNRELATED residents may be demoted first. Remaining gaps:

1. Oversized candidate (`sizeBytes > 64 MiB cap`) should go DIRECTLY to durable spill and install only its stub — never resident, never demoting unrelated chains. Keep spill (replay availability), do not adopt PR #841's plain rejection.
2. Snapshot input not size-bounded before `readFileSync`/`JSON.parse` (`src/responses/state.ts:453`) — an externally oversized `responses-state.json` is parsed whole.
3. Spill replay materialization unbounded: `readResponseSpill` (`src/responses/spill-store.ts:307`) reads+parses with no replay ceiling and does not charge `storedResponseBytes` (`src/responses/state.ts:666`).
4. `writeBoundedSnapshot` (`src/responses/state.ts:485`) uses JS string length, not UTF-8 bytes, for the 2 MiB/24 MiB limits.

### #847 — tool-argument bounds: two narrow gaps (mostly landed)

Current: translator budget (2 MiB/call, 32 MiB/turn, 32 MiB SSE) covers OpenAI Chat (`src/adapters/openai-chat.ts:801`), streaming+batch bridge (`src/bridge.ts:851`, `:1468`), Responses-to-Chat streaming (`src/chat/outbound.ts:168-198`). Remaining gaps:

1. Non-stream collector `collectChatCompletion()` charges tool args to generic `retained_collectors` scope (`src/chat/outbound.ts:621`, `:700`) — one call can consume nearly the full 32 MiB turn budget instead of the 2 MiB per-call limit. Fix: per-call ownership by stable index/call ID.
2. `translatorBudget` is OPTIONAL in the bridge option type (`src/bridge.ts:136`) — a future caller omitting it gets an unbounded append helper. Make it mandatory (all production callers pass one today).
3. Overflow contract inconsistency: Chat outbound maps translator overflow to 413 `invalid_request_error`; adapter/bridge use 502 `upstream_error`. Normalize to 502.

Decisions (recorded, not silent): keep the shared SSE record ceiling at 32 MiB (PR #847's 4 MiB could reject legitimate large compatible-provider records); keep typed `translation_buffer_limit` overflow (no `arguments.done`, no completed item, no clean Chat DONE — already the bridge behavior).

### #844 — Cursor Connect frames: incremental remainder + partial-EOF (refinement)

Current: declared-length validation at header arrival exists (`src/adapters/cursor/framing.ts:171`), 32 MiB declared / 16 MiB effective caps exist (`src/lib/translator-budget.ts:4`), 1,024-frame flow control exists. Remaining gaps:

1. Concat-first pending handling (`src/adapters/cursor/live-transport.ts:894`, `concatBytes()` at :906-918): every chunk is concatenated with the ENTIRE pending remainder. Fix: complete only the missing header/payload portion incrementally; carry at most one bounded incomplete frame.
2. Partial-EOF (`live-transport.ts:949`): complete frame(s) + trailing incomplete frame settles SUCCESSFULLY and silently discards the remainder. Fix: fail the turn with typed `frame_incomplete` on non-expected EOF when pending bytes remain (after accounting for queued async frame work; expected client-tool cancellation must NOT error).

Decision: do NOT adopt PR #844's flat 32 MiB effective inbound — current 16 MiB effective preserves the copy-overlap budget inside the 32 MiB transport budget.

### #845 — Cursor blob store: NOOP (verified superseded)

`src/adapters/cursor/native-exec.ts` already has: 16 MiB/entry, 64 MiB aggregate, 4,096 entries, 15-min TTL, request-scope pinning with seal/rollback (`:351`), typed atomic admission failures (`entry_too_large`, `pinned_saturation`, `request_pinned_conflict`, `:219`), protobuf error acknowledgement for rejected `setBlobArgs` (`:551`, wire shape `gen/agent_pb.ts:7904`), per-key hydration release (`:537`), app-owned-memory integration. PR #845's only unretained behavior is true access-LRU — a policy nicety, not a leak. Verdict: NOOP with this evidence; no code change. Residual edge (documented, accepted): remote `setBlobArgs` after scope sealing is TTL-protected only; PR has the same limitation.

### #843 — Antigravity replay: fixed-size identities (refinement)

Current: caps exist (10,240 sessions, 256 calls/session, 2 MiB/session, 64 MiB global counted, 64 KiB signature — `src/adapters/google-antigravity-replay.ts:29`), 1h TTL + centralized sweep. Remaining gaps:

1. Outer key retains raw `model`/`sessionId` (`replayKey`, `:57`) and inner key raw function name + canonical args (`functionCallKey`, `:61`/`:70`) — key bytes are NOT counted in `replayBytes`; an attacker-controlled long model/session pair retains unaccounted strings across up to 10,240 sessions. Fix: SHA-256 fixed-size identities with NUL separators for both key classes (PR #843 shape), preserving native `touchedAtMs`, exact deletion accounting, retained-store snapshot, sweeper, and shared-budget call.
2. Transient canonical JSON allocation before admission checks — large arguments produce an unbounded temporary string. Fix: hash streaming/incrementally or pre-check serialized input size before canonicalization.

Decision: keep native TTL-refresh-on-duplicate-observation (PR #843 does not refresh; changing it alters TTL semantics for no leak benefit).

### #840 — Windows ACL memos: timeout release + destination keying (refinement)

Current: success memos already released after rename/confirmed removal (`src/config.ts:120`, `:137`); async writer keys timeouts by destination (`src/config.ts:187`); residual-file retention is fail-closed (`tests/config.test.ts:1536`). Remaining gaps:

1. Sync `atomicWriteFile` hardens the unique temp WITHOUT a destination memo key (`src/config.ts:107-109`) — a timeout retains `required:<unique-temp>` forever even after cleanup removes the temp. Fix: pass `timeoutMemoKey: destination` (matches async).
2. `forgetHardenedSecretPath` (`src/lib/windows-secret-acl.ts:171`) clears only the success set, not timeout state. Fix: ephemeral release clearing `hardenedPaths` + `timedOutPaths` in BOTH namespaces (`required:`/`optional:`), invoked ONLY after proven absence (successful rename, successful unlink, ENOENT, or explicit `existsSync === false`) at `src/config.ts:125`, `:152`, `:211`, `:238` + management-token/tray temp writers.

Guardrails: never clear the stable DESTINATION timeout memo (intentional anti-restall state); retain memos when a residual temp remains on disk; preserve required/optional namespace isolation. Store F is not registered with the framework — registration is out of scope (memos become self-releasing instead).

## Revised landing order

020 (#841) → 030 (#847) → 040 (#844) → 045 (#845 NOOP record) → 050 (#843) → 060 (#840). Order is dependency-free across subsystems; sequence keeps the prep doc's order minus the NOOP. wt3 coordination stands: #847 edits stay in the translator-budget/collector paths, not `service_tier` injection sites.
