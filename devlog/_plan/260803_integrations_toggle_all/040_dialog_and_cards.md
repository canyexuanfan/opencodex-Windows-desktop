# WP4 — the dialog, and four more switches

> **Rev 2** after audit round 1. Added: one authoritative state model instead of
> two competing status sources (audit #11), and the `partial` outcome's surface.

Direction and copy: `002_consequence_dialog_ux.md`. This doc is the wiring.

## IN

1. `gui/src/pages/integrations/ConsequenceDialog.tsx` — NEW.
2. `gui/src/pages/integrations/native-api.ts` — NEW: client for `030`.
3. `gui/src/pages/integrations/IntegrationsOverview.tsx` — MODIFY: switches for
   the four, dialog gating for three.
4. `gui/src/pages/integrations/overview-clients.ts` — MODIFY: `toggle` is no
   longer file-clients-only.
5. `gui/src/i18n/*.ts` — six locales.
6. `gui/src/styles-integrations.css` — dialog styles.
7. `gui/tests/consequence-dialog.test.tsx` — NEW.
8. `gui/tests/overview-state-merge.test.ts` — NEW: the precedence rules below.

## One state authority

WP3 adds `/api/native-integrations` while the overview keeps its five detail
reads, and rev 1 left the two unreconciled: the switch would follow one payload
while the badge followed another, so an out-of-order refresh could render a card
that says applied with a switch that says off (audit #11).

Precedence, in one pure function beside `buildOverviewRows`:

- **`applied` / switch state** — the native payload wins. It is the writer's own
  view and it is what the PUT just changed.
- **`state` badge** — derived from the SAME native payload, so badge and switch
  can never disagree.
- **`detail` line** — the per-client reads keep it: they carry the facts the
  native payload has no business knowing (auth mode, model count).
- **Not yet settled** — if the native payload has not arrived, the row is
  `unknown` and the switch is DISABLED. A switch whose state we are guessing is
  worse than one the user cannot touch for a moment.

`OverviewCard` changes to read `row.applied` rather than `row.status`, which
also removes the file-client-only assumption baked into the card this morning.

## Dialog component

Modelled on `RestoreDialog.tsx`, which already solved focus, escape and
backdrop for this surface. Differences: it takes structured content rather than
one body string, and its confirm button is named by the caller.

```tsx
export interface ConsequenceCopy {
  titleKey: TKey;
  changesKey: TKey;       // what is written or removed, and where
  breakageKey: TKey;      // what stops working
  undoKey: TKey;          // honest, including what cannot be restored
  sideEffectKey?: TKey;   // rendered only when present
  confirmKey: TKey;       // names the action, never "확인"
  vars?: Record<string, string>;  // the literal path
}
```

Four slots in fixed order (`002` §Structure). `sideEffectKey` is optional and
its paragraph is omitted entirely when absent — an always-present empty row
teaches the eye to skip that position, which is where the Codex restart warning
lives.

The path is interpolated from the live status payload, never hardcoded: a user
with `CODEX_HOME` or `GROK_HOME` set must see THEIR path or the dialog is
lying.

## Card wiring

`OverviewRow.toggle` widens from `FileIntegrationClientId | null` to
`OverviewClientId | null`. `OverviewCard` already renders a switch whenever
`toggle` and `onToggle` are set, so the card component needs no structural
change — only the row builders stop returning `null` for the four.

Gating lives in the overview, not the card:

```ts
const requestToggle = (row: OverviewRow, next: boolean) => {
  // Claude Code flips one boolean in our own config and moves nothing on disk,
  // so a confirmation there is friction with no payload (UX-LAZY-01, 002 §gate).
  if (next || row.id === "claude" || row.toggle === null) return void commit(row, next);
  setPendingToggle(row);   // Codex, Desktop, Grok: confirm first
};
```

Enabling is never gated. The dialog exists because removal touches files other
programs read; adding our block back is the reversible direction and the state
the product ships in.

## Refusals

Rendered in the card's notice area, not a second modal (`002` §Refusals are not
dialogs). `describeRefusal` gains the four native reasons; its existing
`snapshotPath`/`residual` handling carries over unchanged.

The `home_mismatch` copy must NOT say "stop the service" — the trigger is a home
mismatch, not a running service (`001` §The guard I described wrong). It names
both homes and leaves the resolution to the user.

`partial` is not a refusal and must not be styled as one. It renders as a
persistent error notice naming every residual path plus a direct link to the
Rollback Centre entry for its `opId` — the user's handle on a half-changed
state.

## Verification

A dialog is a render artifact, so C runs the render-grounding loop
(C-RENDER-GROUNDING-01), not just a mounted-component assertion:

1. Open each of the three dialogs in the real browser.
2. Screenshot, and READ the screenshot back.
3. Assert the rendered Korean text names the real path from the live payload.
4. Drive one full disable→enable round trip per client and confirm the card
   state and the server state agree afterwards.

## Acceptance

- [ ] All four switches toggle both directions from the overview.
- [ ] Codex, Desktop and Grok toggle-off open a dialog; Claude Code does not.
- [ ] Enabling never opens a dialog.
- [ ] Each dialog names the live path from the payload, not a constant.
- [ ] Confirm buttons read "해제"/"복원", never "확인".
- [ ] A refusal renders in the card notice with its localized explanation.
- [ ] `home_mismatch` copy does not tell the user to stop a service.
- [ ] Badge and switch never disagree: a test drives every combination of
      settled/unsettled native payload against each detail payload.
- [ ] An unsettled native payload disables the switch rather than guessing.
- [ ] `partial` renders residual paths and links its Rollback Centre entry.
- [ ] Six locales carry every new key.
- [ ] Dialog is keyboard-reachable, escape-dismissible, focus-trapped.
- [ ] Browser screenshots read back for all three dialogs.
- [ ] gui test, gui lint, typecheck green.
