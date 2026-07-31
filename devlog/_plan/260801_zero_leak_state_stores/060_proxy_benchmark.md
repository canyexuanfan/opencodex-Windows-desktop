# 060 — proxy no-leak benchmark skeleton

Date: 2026-08-01  
Work phase: wp7  
Depends on: 010–055 landed and re-audited  
Status: SKELETON ONLY; wp7 owns evidence population  

## Purpose

This is the only document allowed to make a comparative superiority claim for the unit.
It must compare production TypeScript-based LLM proxies from opened source, separate
translation-duty products from pure relays, and distinguish a finite theoretical bound
from operational cleanup that merely “usually happens.”

All result cells below remain `TBD` until wp7 opens a commit-pinned source URL, records
the observed implementation, and rechecks OpenCodex after 010–055 land.

## Evidence rules

- Prefer commit-pinned GitHub source URLs, then release notes/issues for historical
  context. Repository home pages are discovery pointers, not sufficient proof.
- Record source-open date, commit/tag, exact file/function, bound dimensions, and cleanup
  trigger. Search snippets and README claims are not implementation evidence.
- Classify count, per-entry bytes, aggregate bytes, TTL, admission, active-resource
  ownership, and upstream cancellation independently.
- A process restart is not an eviction policy. External Redis/DB is not app-owned RAM,
  but client/request buffers and local registries still count.
- “No continuation store” is not automatically stronger when the product is a pure relay;
  translation duty and replay semantics must be called out.
- Any ambiguous cell is `UNKNOWN`, not `PASS`.

## Evidence URL ledger

The current `005_impl_roadmap.md:16-30` contains Luna findings but no literal URLs.
Source anchors were verified against `86a82246b827524d074ef0cfed37241b96722000`;
the shared checkout later advanced to docs-only commit
`860ec897bbc23e04a7b07e93bfcd1dac20e7609f` with `src/` and `tests/` byte-unchanged.
Seed repository/issue roots here; wp7 must replace or supplement each with commit-pinned
file URLs.

| Subject | Discovery URL | Exact source permalink | Opened at wp7 | Notes |
|---|---|---|---|---|
| Portkey Gateway | https://github.com/Portkey-AI/gateway | TBD | TBD | Luna named `streamHandler.ts` / `streamHandlerUtils.ts`. |
| Claude Code Router | https://github.com/musistudio/claude-code-router | TBD | TBD | Luna found AbortController/upstream cancel and context archive TTL+count+bytes. |
| punkpeye mcp-proxy | https://github.com/punkpeye/mcp-proxy | TBD | TBD | Luna found 1,000-event FIFO and close-owned sessions. |
| LiteLLM | https://github.com/BerriAI/litellm | TBD | TBD | Verify current cache and streaming retention, not only release history. |
| LiteLLM issue 6404 | https://github.com/BerriAI/litellm/issues/6404 | n/a | TBD | Historical issue evidence only. |
| one-api | https://github.com/songquanpeng/one-api | TBD | TBD | Verify default memory-cache posture and external state boundaries. |
| lru-cache precedent | https://github.com/isaacs/node-lru-cache | TBD | TBD | Precedent, not a competitor row. |
| cacache precedent | https://github.com/npm/cacache | TBD | TBD | Spill precedent, not a competitor row. |
| OpenCodex | repository under this unit | commit-pinned local/GitHub URLs TBD | TBD | Must point at landed 010–055 code and tests. |

## Comparison categories

Score each category as `PASS`, `PARTIAL`, `FAIL`, `N/A`, or `UNKNOWN`, with one evidence
URL and a one-sentence reason. “PASS” means a finite contract exists in production code
and the relevant negative/boundary test exists.

1. request/body admission before large allocation;
2. upstream abort on client disconnect/cancel;
3. per-stream frame and producer-queue bounds;
4. tool/reasoning/output translator aggregate bounds;
5. continuation/replay count + TTL + per-entry + aggregate bytes;
6. durable spill ordering and explicit missing/corrupt replay semantics;
7. content/blob cache provenance, per-entry bytes, aggregate bytes, TTL/LRU;
8. diagnostic rings: count and value-byte bounds;
9. stale-key TTL sweep and config-generation reconciliation;
10. active turns/sockets/workers/flights admission caps;
11. serialized-tail/backlog admission;
12. background process/session lifecycle;
13. process-wide retained-store byte budget and deterministic demotion order;
14. observe-only, privacy-safe app-owned byte metrics;
15. security boundary for secret-file atomic writes/ACL memo lifecycle;
16. normal 20+ parallel tool-call acceptance without truncation.

## Competitor matrix — wp7 data cells

| Category | OpenCodex | Portkey | Claude Code Router | mcp-proxy | LiteLLM | one-api |
|---|---|---|---|---|---|---|
| 1. Request admission | TBD | TBD | TBD | TBD | TBD | TBD |
| 2. Disconnect abort | TBD | TBD | TBD | TBD | TBD | TBD |
| 3. Stream/frame queue | TBD | TBD | TBD | TBD | TBD | TBD |
| 4. Translator aggregate | TBD | TBD | TBD | TBD | TBD | TBD |
| 5. Continuation dimensions | TBD | TBD | TBD | TBD | TBD | TBD |
| 6. Spill + explicit replay miss | TBD | TBD | TBD | TBD | TBD | TBD |
| 7. Blob/cache dimensions | TBD | TBD | TBD | TBD | TBD | TBD |
| 8. Diagnostic value bytes | TBD | TBD | TBD | TBD | TBD | TBD |
| 9. Expiry/reconciliation | TBD | TBD | TBD | TBD | TBD | TBD |
| 10. Active admission | TBD | TBD | TBD | TBD | TBD | TBD |
| 11. Tail admission | TBD | TBD | TBD | TBD | TBD | TBD |
| 12. Background lifecycle | TBD | TBD | TBD | TBD | TBD | TBD |
| 13. Global retained budget | TBD | TBD | TBD | TBD | TBD | TBD |
| 14. App-byte observability | TBD | TBD | TBD | TBD | TBD | TBD |
| 15. Secret-file hardening | TBD | TBD | TBD | TBD | TBD | TBD |
| 16. 20+ call acceptance | TBD | TBD | TBD | TBD | TBD | TBD |

## Per-competitor evidence rows

Populate at least one row per material category; add rows rather than packing multiple
claims into one citation.

| Competitor | Category | Verdict | Commit/tag | File/function | Source URL | Exact bound/behavior | Test URL | Caveat |
|---|---|---|---|---|---|---|---|---|
| OpenCodex | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Translation duty. |
| Portkey | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Claude Code Router | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| mcp-proxy | TBD | TBD | TBD | TBD | TBD | TBD | TBD | MCP/session focus. |
| LiteLLM | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Python runtime; include only if wp7 keeps the broader production-proxy cohort. |
| one-api | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Go runtime; external state distinction required. |

## Gap-list gate

Create a final gap list from every OpenCodex `PARTIAL`, `FAIL`, or `UNKNOWN` cell and
every category where a competitor has a materially stronger finite contract.

The wp7 gate passes only when one of these is true for every gap:

- the gap is closed by landed, tested code in 010–055 and the matrix is updated; or
- the gap is converted into a numbered work phase with owner, exact files, acceptance
  tests, and dependency placement, and this unit is not closed until that phase lands.

An unexplained `N/A`, a planned-but-unlanded phase, or “low practical risk” does not
empty the gap list. The final section must literally record `Open gap count: 0` before
070 may proceed.

## Superiority-claim rule

No claim may appear in `005`, release notes, README, social copy, or PR description
before this table is complete. After the empty-gap gate:

- category claims may say “stronger than the surveyed proxies in category X” only when
  every competitor has opened evidence and OpenCodex is strictly stronger there;
- the broad claim “strongest theoretical no-leak posture among surveyed production
  TypeScript LLM proxies” requires no `UNKNOWN` cells in that cohort and no category
  where a competitor is stronger;
- never claim “leak-free,” zero RSS growth, or stronger than projects outside the frozen
  cohort;
- name survey date, cohort, and theoretical/app-owned scope in the sentence;
- if evidence is mixed, publish the matrix and omit the superiority sentence.

## wp7 completion checklist

- [ ] Freeze competitor repository SHAs/tags and source-open date.
- [ ] Replace every source `TBD` with commit-pinned URLs or mark `UNKNOWN` with reason.
- [ ] Re-open landed OpenCodex source/tests; do not score from roadmap prose.
- [ ] Complete all 16 category rows and per-competitor evidence rows.
- [ ] Resolve cohort consistency for LiteLLM/one-api versus TypeScript-only headline.
- [ ] Record and close/phase every gap.
- [ ] Record `Open gap count: 0`.
- [ ] Add the one permitted scoped superiority statement, or explicitly omit it.

## Commit

`docs(devlog): record zero-leak proxy benchmark evidence`

## Explicitly not changed

- This skeleton does not assign final verdicts, fill benchmark measurements, or claim
  superiority; wp7 owns those evidence-backed conclusions.
- No runtime, test, config, dependency, benchmark harness, release, or provider behavior
  changes in this document.
- No popularity, star count, or throughput result is treated as a retention guarantee.
