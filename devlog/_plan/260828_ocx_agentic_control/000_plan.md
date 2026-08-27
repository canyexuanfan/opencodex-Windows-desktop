# 000 — ocx as a complete agentic control surface

## Objective

Make the `ocx` CLI a complete, scriptable control surface for every capability the
web dashboard exposes, so an AI agent can operate opencodex end to end from a
terminal with machine-readable output and honest exit codes. Close the ten
operator-facing CLI issues (#2696-#2705) at their root causes rather than at their
symptoms, give help a single source of truth that a test can hold to the API
surface, and ship a repo-owned agent skill that documents the resulting surface.

## Why this unit exists

The dashboard is the complete surface today and the CLI is a partial mirror of it.
Three separate failure classes make the CLI unusable for unattended agent control:

1. **Transport dishonesty.** `ocx models live` and `ocx provider quota` print an
   error and exit 0 (#2697); a 503 arrives with a `reason` and `hint` the CLI
   never renders (#2698); a launchd install can fence the entire management plane
   closed and the CLI cannot say why (#2696); the PATH binary can be older than
   the running proxy while its help claims otherwise (#2701).
2. **DTO loss.** The API already returns fields the CLI throws away: usage
   `accounts[]` (#2700), account `paused` and the 5h quota window (#2703), access
   key `usage.requests7d`/`lastUsedAt` (#2705). One of these is worse than filed:
   `projectQuota` strips `fiveHourPercent` before any renderer runs.
3. **Missing verbs.** Pause/resume, pool strategy, sticky limit (#2702) and
   `logs --conversationId` (#2704) exist as routes with no CLI caller, plus 13
   further GUI-only capability classes found by inventory.

Underneath all three sits the real defect: **there is no source of truth binding
the CLI surface to the API surface.** Help lives in a hand-written 69-line banner
plus 37 module-level usage blocks — 20 of them exported constants with zero
consumers outside their own files — all free to drift. Nothing fails when a route
lands with no verb.

## Constraints

- Bun-native TypeScript. No compile step, no Node-only APIs.
- `src/lab/` must stay off the core request path; `tests/core-lab-boundary.test.ts`
  and the `startServer` synchronous-window scan are hard gates.
- Management auth is applied before dispatch for every `/api/` path. Three routes
  require a browser session and MUST NOT get a CLI verb: `POST /api/github/star`
  (user-consent boundary, `AGENTS_INSTALL.md`), the non-GET `/api/codex-prompt*`
  verbs, and `POST /api/providers/reload` (capability principal, not a session).
- `PUT /api/config` is a deliberate 405. Not a parity target.
- No security triage in `devlog/`. Scratch space only.
- Per the operator's instruction for this unit: no local full-suite runs during
  build, no per-push CI polling, `--no-verify` pushes, and a single final
  rebase-onto-`dev` plus parallel CI triage at the end.

## Measured surface (see 001, 002, 003)

| Surface | Count | Source |
|---|---|---|
| Reachable management routes | 183 (108 mutating) | 001 |
| Dead/shadowed routes | 1 (`GET /api/storage` in logs-usage-routes) | 001 |
| Session-only routes (never CLI) | 3 | 001 |
| CLI dispatch runner keys | 57; registry 58 entries, 52 visible | 002 |
| Disconnected help sources | 37 usage blocks (20 dead module exports) + 1 banner | 002 |
| GUI-only capability classes | 13 declared, 8 real gaps after exemptions | 003 |
| Reviewer blockers folded at the A gate | 7 blockers + 4 medium + 2 low | 005 |

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

Each phase consumes the verified output of the previous one. Ordering is by build
structure — contract first, then the machinery that depends on the contract, then
the capabilities that machinery exposes, then documentation of the finished
surface — not by effort or payoff.

| Phase | Doc | Deliverable | Depends on |
|---|---|---|---|
| wp2 | `010` | Transport honesty: exit codes, error rendering, token-collision refusal (#2697 #2698 #2696) | — |
| wp3 | `020` | Capability registry as help SoT + API/CLI parity test + version skew (#2701) | wp2 |
| wp3b | `025` | Uniform CLI contract: exit codes and `--json` order-independence | wp3 |
| wp4 | `030` | DTO fidelity (#2700 #2703 #2705) | wp3b |
| wp5 | `040` | New verbs and filters (#2702 #2704) | wp3 |
| wp6 | `050` | Per-account OAuth usage attribution (#2699) | wp4 |
| wp7 | `060` | Residual GUI-parity closure (13 capability classes) | wp3 wp5 |
| wp8 | `070` | `ocx` agent skill + docs-site CLI reference | wp7 |
| wp9 | `080` | Stack rebase onto `dev`, final parallel CI triage | all |

wp2 comes first because every later phase is verified through CLI output: a phase
that lands while `ocx` still exits 0 on failure cannot be proven. wp3 comes second
because the registry it introduces is the thing every later phase registers into —
adding verbs before the registry means writing them twice.

wp3b exists because the uniform exit-code and `--json` contract *consumes* wp3's
capability table (its tests read each capability's declared `json` mode), so it is a
successor phase rather than a slice carved off to balance effort. PHASE-SPLIT-01
forbids effort buckets, not dependency-ordered successors.

wp6 follows wp4 rather than preceding it so that the `accounts` renderer already
exists when the labels start being stamped — the phase's proof is then visible in
`ocx usage` immediately instead of requiring a later phase to demonstrate it.

## Delivery shape

A stacked pull-request chain (DEV-STACK-01), one PR per work-phase, each child
targeting its parent's head branch. Base of the stack is `origin/dev`.

```
dev
 └── codex/ocx-agentic-control-roadmap        wp1  (this unit's docs, PR #2773)
      └── codex/ocx-transport-honesty          wp2
           └── codex/ocx-capability-registry     wp3
                └── codex/ocx-uniform-contract     wp3b
                     └── codex/ocx-dto-fidelity      wp4
                          └── codex/ocx-new-verbs      wp5
                               └── codex/ocx-account-attribution  wp6
                                    └── codex/ocx-gui-parity        wp7
                                         └── codex/ocx-agent-skill  wp8
```

## Accept criteria for the unit

1. Every non-session, non-405 management capability has a CLI verb with `--json`.
2. A parity test fails when a route lands with no verb and no recorded exemption.
3. Help is generated from the registry; no hand-maintained command list survives.
4. Every management failure path exits non-zero and prints `reason` and `hint`.
5. A repo-owned skill documents the surface with copy-paste recipes.
6. The whole stack is rebased on current `dev` with CI green.

## Terminal-outcome definitions

`DONE` requires all six above proven against the tree, not remembered.
`BLOCKED` is a platform or credential refusal. `UNSAFE` is any fix that would
weaken the admin-token or session boundary — stop and ask instead.
`NEEDS_HUMAN` is a CLI-grammar choice the operator must make.
