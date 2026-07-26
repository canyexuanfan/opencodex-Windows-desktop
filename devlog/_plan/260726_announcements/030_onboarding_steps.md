# 030 — WP-D: first-run onboarding, 1–5 steps

Depends on WP-B for state, not on WP-C: onboarding and announcements are separate
experiences that share a substrate and a priority rule.

## Priority against announcements

Onboarding wins. A first-run user has no context for "X now supports Y", so a
pending announcement must not compete with, or stack on top of, the onboarding
flow. The rule: while onboarding is incomplete, announcements are held (not
dismissed) and the badge stays hidden. They surface after onboarding finishes or
is skipped.

This also means a fresh install never sees both at once, which is the failure the
shared substrate exists to prevent.

## State

Extends the WP-B config block rather than inventing a parallel store:

```ts
  announcements?: {
    baseline?: { at: string; version: string };
    dismissed?: string[];
+   onboarding?: { completedAt?: string; skippedAt?: string; lastStep?: number };
  };
```

Completed and skipped are distinct on purpose: "skipped" is a signal we may want
to act on later (a gentle re-offer), while "completed" is final. Collapsing them
into one boolean would throw that away.

## Trigger

Shown when the baseline was stamped on a first-ever run and no
`completedAt`/`skippedAt` exists. An existing user upgrading in has a baseline but
is not a new user — the same distinction the no-backfill rule draws — so
onboarding must not fire for them.

### A-phase correction: "no providers configured" does NOT work

The first draft proposed `Object.keys(config.providers).length === 0` as the
"never used this" signal. The audit killed it. `getDefaultConfig()`
(`src/config.ts:886-901`) seeds a fresh config with an `openai` provider and
`defaultProvider: "openai"`, so a brand-new install has ONE provider, not zero.
The condition would never be true and onboarding would never fire — a feature
that silently does nothing, which is worse than not shipping it.

The real first-run signal is the ABSENCE OF THE CONFIG FILE.
`loadConfig` returns `getDefaultConfig()` without writing when the path does not
exist (`src/config.ts:739-741`), so "file missing" is the only unambiguous
"never configured anything" state, and it is checkable before any write happens.

Implementation consequence: `ensureAnnouncementBaseline` must be told whether the
config file existed at the moment of stamping, and record it:

```ts
  baseline?: { at: string; version: string; firstRun: boolean };
```

`firstRun` is captured once, at stamp time, because the file exists immediately
afterward — deriving it later is impossible. Onboarding fires only when
`baseline.firstRun === true`.

## Steps — CONTENT IS AN OPEN QUESTION

The mechanics (stepper, back/next, skip, progress, focus trap, escape behaviour)
are ours to build. WHAT to teach in five steps is a product judgment about which
first action makes a new user successful, and choosing it unilaterally is the
kind of assumption `cxc-dev-uiux-design` UX-INTENT-01 says to surface rather than
bury.

Candidate skeleton, to be confirmed before implementation:

| Step | Candidate |
|---|---|
| 1 | What opencodex is — one screen, one sentence |
| 2 | Add your first provider (the actual first meaningful action) |
| 3 | Point a client at it — Codex CLI / Claude Code / Grok |
| 4 | Where models and combos live |
| 5 | Where to get help |

UX-STATE-01: onboarding teaches the first meaningful ACTION, not the whole
product. Step 2 is the load-bearing one; steps 4–5 are orientation and are the
first candidates to cut if five proves too long.

## TESTS — `gui/tests/onboarding.test.ts` (NEW)

- fires for a first-ever run (`baseline.firstRun === true`);
- does NOT fire for an existing user upgrading in (`baseline.firstRun === false`);
- does not re-fire after `completedAt` or after `skippedAt`;
- announcements are suppressed while onboarding is pending, and appear afterwards;
- back/next/skip move `lastStep` correctly and persist it;
- all six locales carry the step keys.

## Verification (C)

| Command | Expected |
|---------|----------|
| `gui: bun run test` | pass |
| `bun test tests/announcements.test.ts` | pass (priority rule lives server-side) |
| `bun run lint:gui` | clean |
