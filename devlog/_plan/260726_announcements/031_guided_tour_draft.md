# 031 — DRAFT: game-style guided tour (deferred to a later release)

> **Status: DRAFT, NOT SCHEDULED.** Recorded at the maintainer's request so the
> feasibility work is not lost. Target: the release AFTER next, not this unit.
> WP-D (`030_onboarding_steps.md`) ships the plain stepper first; this document is
> the upgrade path from stepper to tour.

## The ask

A first-run experience closer to a game's opening tutorial: advancing a step also
switches the dashboard tab, highlights what the user should look at, and lets them
act inside the real UI rather than reading a description of it.

## Feasibility — verified against the code, not assumed

Two capabilities the tour needs already exist:

| Need | Existing mechanism | Location |
|---|---|---|
| Drive tab changes from outside the sidebar | `navigateToPage(id)` sets the hash AND React state | `gui/src/use-app-route-state.ts:55-58` |
| Address a nav entry to highlight it | every nav button carries `data-page={id}` | `gui/src/App.tsx:242` |
| Deep-link a step | hash routing with deliberate-vs-passive navigation already separated | `gui/src/hash-routing.ts` |

So "next step also opens the Providers tab and points at it" needs no new
navigation plumbing — it reuses the exact path a sidebar click takes.

## Cost is NOT uniform across the idea

This is the part worth recording, because the request reads as one feature and is
really five with an order-of-magnitude spread:

| Capability | Cost | Why |
|---|---|---|
| Step through 1–5 in a modal | low | one state value, existing modal shell |
| Switch tabs on advance | low | one `navigateToPage` call per step |
| Highlight a SIDEBAR entry | medium | `[data-page="..."]` exists; needs an overlay + scroll-into-view |
| Highlight an element INSIDE a page | high | no anchors exist; every target page needs a stable hook added |
| Gate advance on real completion | high | per-step completion detection wired into each page's data |

The first three are a contained increment on top of WP-D. The last two are where
the work multiplies, because they push tour concerns into pages that currently
know nothing about onboarding.

## Design position: guide, do not trap

A game tutorial can block progress because failure costs nothing. Here, step 2 is
"add a provider", which means a real API key. A user without one at that moment
would be stuck inside a modal they cannot satisfy — and this audience is largely
developers already running Codex CLI, for whom forced hand-holding reads as
disrespect rather than help.

Proposed shape: **quest log, not forced tutorial.**

- advancing switches the tab and highlights the target, so the user sees where the
  action lives;
- completion is DETECTED and shown as a check, giving the sense of progress;
- but advance is never blocked on it, and skip is always available.

This keeps the game feel (visible objectives, visible progress) without the
failure mode.

## Known hazard: the tour steals the user's place

Driving tab changes means the user loses whatever they were looking at. The tour
must capture the page it started on and restore it on skip or finish. Without
that, closing the tour leaves the user somewhere they did not choose — a small
detail that reads as the whole feature being broken.

## Open questions (carried into Interview, not decided here)

1. Highlight scope: sidebar entries only, or in-page elements too? The second
   requires adding anchors to each target page.
2. Progression: guide-but-never-block (recommended above), or genuinely gated?
3. Completion detection: which signals count as "done" per step, and can they be
   read from data the dashboard already fetches?

## Dependency

Requires WP-B's state substrate (baseline + `onboarding.lastStep`) and WP-D's
stepper. Building the tour first would mean inventing tour-specific state that the
substrate then has to absorb.
