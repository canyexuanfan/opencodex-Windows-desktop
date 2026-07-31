# 006 — roadmap audit synthesis

## Round 1 (reviewer Maxwell, FAIL 7) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| R1-1 | Coverage gap: phases don't own every leak verdict (cursor shells, debug subscribers, pool/oauth/guardian history, ownership memos, active registries, MCP payloads, refresh flights, MiMo JWT, usage-read; translator accumulators beyond tool-args/cursor framing) | ACCEPT | 005 gains a full ownership matrix: every one of the 36 stores mapped to a phase OR given an explicit NON-MATERIAL (with why) / DEFERRED-#820 (with why) verdict. New phase 035 (registry & flight admission caps) absorbs the orphaned operational stores; 050 scope widened to ALL translator accumulators. |
| R1-2 | Windows ACL "keying fix" unsafe: success memo by destination could skip hardening future temps | ACCEPT | Remedy redefined: success on an ephemeral temp is NOT memoized persistently (removed after rename); destination-key memoization stays timeout-only, matching windows-secret-acl.ts:47 doctrine. Moved out of the sweeper phase into its own 030 sub-item with this exact contract. |
| R1-3 | Continuation disk path not reusable as spill-through (2 MiB skip / 24 MiB stop / debounced best-effort whole-snapshot / sync APIs) | ACCEPT | 010 redesigned: spill is a NEW per-entry content-addressed file write with durable-success-before-stub-swap transaction, defined read-miss contract (replay returns not-found → client falls back to full-context resend, same as TTL expiry today), and the legacy snapshot path untouched for small entries. UNSAFE boundary retained. |
| R1-4 | Crash ring BOUNDED verdict hides uncapped value strings; fixed-slot/affinity value bytes unaudited | ACCEPT | Inventory corrected (crash ring → CONDITIONALLY-UNBOUNDED, value-byte audit noted for fixed-slot diagnostics and affinity); 030/035 include value-byte truncation for retained diagnostic strings. |
| R1-5 | Universal 60 s sweeper unsafe for warning memos (no expiry, intentional suppress), codex quota rows (6 h is hydration-admission only; live getters return rows indefinitely), ACL memos | ACCEPT | 030 split into three mechanisms: (a) exact-expiry sweep only for stores whose getters already treat expired as absent; (b) config/account-generation reconciliation for keyed stores (drop keys no longer in current config/accounts — behavior-preserving because dead keys are unreachable); (c) ACL-specific contract per R1-2. Warning memos: reconciliation-only, never TTL. Codex quota rows: reconciliation-only, never TTL. |
| R1-6 | Dependency graph inconsistent: 040 claims a 030 accounting dependency that 030 doesn't provide; 050 not parallel-safe if the global budget includes translator buffers | ACCEPT | 040 depends on 010/020/035 accounting hooks (030 provides none); budget scope split: BUDGET covers evictable RETAINED stores only (continuation, blobs, rings, caches); translator per-stream buffers are OBSERVED (high-water in appOwnedBytes) but never budget-evicted (in-flight state can't be evicted coherently). With that split 050 is genuinely parallel. |
| R1-7 | "Strictly stronger in every category" premature before 060's table exists | ACCEPT | 005 conclusion reworded to a HYPOTHESIS the 060 gate must prove (empty-gap-list required); superiority claim removed until then. |

All seven accepted — no rebuttals. Re-audit with the same reviewer after amendments.

## Round 2 (reviewer Singer, FAIL 5) — adjudication (IDs S2-*)

| # | Blocker | Decision | Action |
|---|---|---|---|
| S2-1 | Ownership orphans: cursor discovery bytes/gather flights, OAuth pending-code values + auth flow/probe admission, usage-read value bytes (staleness guard ≠ byte bound) | ACCEPT | 035 scope extended to own all three explicitly (incl. bounded parse for usage-read so the in-flight value is byte-capped). |
| S2-2 | Crash-ring detail row still BOUNDED; affinity value-byte coverage promised but unrecorded | ACCEPT | Inventory detail row corrected to CONDITIONALLY-UNBOUNDED; 035 adds affinity value-byte truncation explicitly. |
| S2-3 | 040 dependency row still said 010,020,030 | ACCEPT | Phase-map row corrected to 010,020,035. |
| S2-4 | 035 had no regression-class requirements | ACCEPT | Regression classes added for every 035 item. |
| S2-5 | Inventory still recommended destination/generation ACL re-keying (twice); 030 mechanism assignment not locked store-by-store | ACCEPT | Both inventory sites rewritten to delete-after-rename with the doctrine citation; 005 gains the store-by-store mechanism lock table. |

All five accepted. Re-audit round 3.

## Round 3 (reviewer Singer, FAIL 4) — adjudication (IDs S3-*)

| # | Blocker | Decision | Action |
|---|---|---|---|
| S3-1 | 040 (wp5) sequenced before its dependency 035 (wp5b) | ACCEPT | 035 renumbered wp4b and moved above 040 in the phase map; execution order now satisfies the accounting-hook dependency. |
| S3-2 | XAI verdicts (30 s TTL, exact-key lazy expiry) wrongly under reconciliation | ACCEPT | Moved to mechanism (a) TTL sweep in the lock table. |
| S3-3 | Active registries "admission counter" and refresh flights "staleness guard" do not impose finite bounds | ACCEPT | 035 remedies upgraded: active turns/sockets/workers get a hard admission CAP (reject beyond cap with a coherent busy error) + leak metric; refresh flights get bounded distinct-grant admission (cap on concurrent distinct grant fingerprints) + staleness replacement. |
| S3-4 | Duplicate "Round 2" headings / colliding R2-* IDs in this file | ACCEPT | Rounds relabeled: implementation-review rounds from the PREVIOUS unit keep R*-; this unit's roadmap-audit rounds use S2-*/S3-*; roadmap references updated. |

## Round 2 (parallel reviewers Raman FAIL 5 / Godel FAIL 2) — adjudication

Raman's five findings substantially overlap Maxwell's round 1 (UNBOUNDED
coverage, spill safety, blob provenance, sweeper matrix, ACL keying) and are
already folded above. The two NET-NEW blockers from Godel:

| # | Blocker | Decision | Fix |
|---|---|---|---|
| R2-1 | 010: "spill failure keeps the row hot" contradicts the hard cap — a failing disk leaves oversized rows resident indefinitely | ACCEPT | Failure ladder locked: (1) spill success → stub swap; (2) spill FAILURE → the row is EVICTED from RAM and the response id records a small `spill-failed` tombstone; later continuation against that id returns the same explicit structured not-found/error contract as a corrupt spill (client falls back to full-context resend). Continuity is sacrificed only on real disk failure, surfaced via warning + counter — never silently. The RAM cap is unconditionally hard: every over-cap row spills or is tombstone-evicted within the bounded in-flight window. |
| R2-2 | 020: pinned remote blobs can collectively exceed the aggregate cap; pre-insert admission undefined; deferring to 040 invalid (040 depends on 020 accounting) | ACCEPT | Admission ladder locked in 020: the aggregate cap is enforced AT INSERT for every provenance. If inserting a remote blob would exceed the cap after evicting all evictable (local/TTL-expired) entries, the insert is REJECTED and the hash takes the explicit-miss path (identical protocol surface to an evicted-hash miss). Pinning orders eviction preference only — it never overrides the aggregate cap. Pinned-saturation regression added to 020's class list. |

Both preserve the structured-error-over-silent-corruption principle. 005
amended accordingly (failure ladder + admission ladder).

## wp2 A-gate (reviewer Banach, FAIL 5) — adjudication

| # | Blockers | Decision | Action |
|---|---|---|---|
| B1-B5 | Spill read lacked a trusted expected id; same-id/equal-size replacement collided and relied on non-portable rename-over-existing; automatic client fallback was unproven; resident measurement was incomplete/weightless on serialization failure; the 3 MiB restart fixture did not cross the 64 MiB spill threshold | ACCEPT | 010 now passes `responseId` into spill reads; uses payload-digest plus generation-distinct basenames and post-swap old-file unlink; defines caller-driven terminal structured 400 recovery; measures the complete retained payload in UTF-8 and tombstones serialization failures; lowers the test cap beneath spill fixtures; records all five current contract-test redefinitions, consumer seams, expanded regression classes, and process-crash-only durability. 005 receives the matching one-sentence recovery correction. |
