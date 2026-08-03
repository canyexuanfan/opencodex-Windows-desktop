---
title: FAB-00 TypeScript/Go Runtime Authority
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 120 -- TypeScript/Go Runtime Authority

## 1. Decision

**`IMPLEMENTATION_BLOCKED_PENDING_GO_AUTHORITY`**

Contracts, fixtures, the spike kernel, and all FAB-00 documents may stand. Production implementation waits for explicit maintainer authority on the language question (below).

## 2. Why not `GO_FIRST_AUTHORISED`

The master plan ?7 asserts "a parallel Go migration line ... applicable behaviour must eventually exist in the Go runtime." FAB-00 evidence (`010` ?8) **invalidates** this premise:

- No `go.mod`, no `*.go` in the repo. OpenCodex is 100% TypeScript/Bun.
- OpenAI Codex itself is Rust (`codex-rs`), not Go. There is no upstream Go line to inherit.
- System-wide Go (`go1.26.4`) is installed but the project does not use it.

So `GO_FIRST_AUTHORISED` is not a valid decision against current repo state -- there is no Go runtime to be "first" in, and no migration line to defer TypeScript behind.

## 3. Why not `PROGRAMME_REJECTED`

The programme direction (durable cross-harness task continuity) is **sound** (`030`/`150`): Codex and Claude are both externally manageable; the task kernel is feasible; the continuity layer is a real gap. Only the *means* (language) is wrong, not the *end*. Rejection is disproportionate.

## 4. Correction required (the recommendation FAB-01 authority depends on)

The maintainer must choose exactly one:

**(A) Re-scope to TS-native Supervisor (recommended).** The Supervisor is TypeScript/Bun, matching the existing repo and its `@bufbuild/protobuf` / MCP / zod stack. Contracts are protobuf (cross-language anyway). This is the lowest-friction path and avoids building/maintaining a second runtime. Under (A), the plan's ?7 "no dual complete implementations" rule is satisfied trivially (one runtime).

**(B) Author a Go migration line.** The maintainer explicitly commits to migrating OpenCodex to Go, after which the Supervisor is Go-native and TypeScript receives only launcher/dashboard/shims. Under (B), contracts/docs may land on `dev` now, but no production Fabric code until the Go line exists and has maintainer/branch approval.

A full TypeScript kernel "ported later to Go" is **not** a passing decision without explicit maintainer override and recorded cost (?7 rejected option).

## 5. Duplicate-kernel prevention (regardless of A or B)

- Contracts (protobuf envelope + JSON Schema fixtures) are language-neutral and shared.
- Conformance fixtures are cross-language; both a TS and a Go implementation must pass the same fixtures.
- One Supervisor process boundary; adapters may be in-process TS (Claude SDK) or RPC (Codex app-server) regardless of the Supervisor's language.
- No second event-store, lease, workspace, or handoff kernel.

## 6. Required maintainer/branch approvals

- For (A): maintainer ACK that the Fabric is a new opencodex subsystem in TS; branch off `dev` (not `main`).
- For (B): maintainer ACK of a Go migration plan + branch policy before any production code.

## 7. Evidence locations

`010` ?8 (no Go), `010` ?11 (go1.26.4 installed), `150` Spike C (disposable Go kernel demonstrates Go feasibility but does not establish a repo Go line), `020` F (invalidated assumption).
