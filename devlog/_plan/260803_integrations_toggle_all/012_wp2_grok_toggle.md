# WP2 — Grok Build

> **Rev 2** after audit round 4 (`007_audit_synthesis_r4.md`). The journal and
> snapshot machinery is GONE from this phase. Round 4 forced the question I had
> been avoiding: what is Grok's undo, actually?

## Undo is the enable path

Turning Grok back on regenerates the fence from the current catalog — the same
work `syncGrokConfig` does, though the route calls `injectGrokConfig` directly
for a reason given below (§One preflight is not enough). That is the undo. It is also strictly better
than replaying a snapshot: a snapshot from an hour ago carries a stale model
list, while the enable path writes what the proxy serves right now.

Rev 1 planned a byte snapshot anyway, reasoning that the file IS the
integration. Re-examined: the snapshot was never the undo mechanism. It was
insurance against a botched strip — and `stripGrokConfig` is already
fence-scoped, already preserves user bytes outside the markers verbatim, already
restores the file's dominant EOL, and already refuses outright when the fence
boundary is ambiguous (`001` §Grok). Insurance against a writer that careful,
for a file whose contents we can regenerate, is machinery without a job.

What the byte snapshot WOULD have protected — a user's hand edits inside our
fence, or the exact fence bytes from before a catalog change — is content we
deliberately own and rewrite on every sync. Restoring it would fight the writer.

So this phase carries no journal row and no snapshot either.

## IN

1. `src/server/management/native-integration-routes.ts` — MODIFY (created in
   WP1): add `PUT /api/native-integrations/grok` and Grok's `GET` row.
2. `src/integrations/native/ownership-preflight.ts` — NEW: the service-home
   check that makes `home_mismatch` reachable (audit r1 #5).
3. `src/grok/inspect.ts` — NEW: the non-mutating inspector (below).
4. `src/grok/inject.ts` — MODIFY: export `findManagedRegion` as an internal API
   so the inspector shares it (audit r6 #3). One exported parser, not a second
   copy — two parsers for one fence is how a strip eventually removes the wrong
   bytes. Nothing else in the writer changes.
5. `tests/native-grok-toggle.test.ts` — NEW.

## A read-only inspector, because GET must not mutate

`030`'s `disableBlocked` needs to know whether a disable would hit
`orphaned_marker` — but the only code that can answer that today is
`stripGrokConfig`, which writes, and its boundary parser `findManagedRegion` is
private (`src/grok/inject.ts:49`). An implementer would have had to invent the
contract (audit r5 #3).

```ts
// src/grok/inspect.ts — NEW

export type GrokInspection =
  | { kind: "absent" }            // no fence, or no config file
  | { kind: "present" }           // a well-formed fence we own
  | { kind: "not_installed" }     // no GROK_HOME
  | { kind: "orphaned_marker" };  // begin without end — a disable would refuse

/** Reads. Never writes. Shares `findManagedRegion` with the writer so the two
 *  can never disagree about where our block starts and stops. */
export function inspectGrokConfig(opts?: { grokHome?: string }): GrokInspection;
```

`findManagedRegion` is currently private to `inject.ts` (`src/grok/inject.ts:49`)
and ES modules cannot share an unexported symbol, so WP2 exports it. It stays an
internal API — the inspector and the writer are its only callers.

**In GET it is advisory.** A file can change between the GET and the PUT, so
`disableBlocked` cannot promise the PUT will succeed. It exists to avoid
offering an action we already know is blocked, not to replace the check.

### In PUT it is the authoritative preflight — for BOTH directions

This is the fix for a defect round 6 found one branch below the one round 5
found (audit r6 #4).

Enabling under a non-loopback bind calls `stripGrokConfig` first. If the file
holds a begin marker with no end marker, that strip returns
`ok: false, skippedReason: "orphaned-marker"` and changes nothing
(`inject.ts:474`) — but `injectGrokConfig` reads only `removed.changed` and
discards the rest (`inject.ts:357-363`). It then reports non-loopback success
with `changed: false`, and the fence is still sitting in the file.

Landing the card on `absent` there would be a lie: the block exists, we just
could not safely touch it.

So PUT runs `inspectGrokConfig` BEFORE calling either delegate, in both
directions, while holding the client guard:

```ts
const seen = inspectGrokConfig({ grokHome });
if (seen.kind === "not_installed") return refusal(404, "not_installed", ...);
if (seen.kind === "orphaned_marker") return refusal(409, "orphaned_marker", ...);
// disable only: shared teardown must not run under a foreign-home service
if (!enabled) { const owned = assertNativeTeardownOwned(); if (!owned.ok) return refusal(409, "home_mismatch", ...); }
```

An ambiguous fence therefore never reaches the code path that would misreport
it, and the refusal is identical whichever direction the user was heading —
which is right, because the reason is the same: we cannot tell where our block
ends.

### One preflight is not enough — `syncGrokConfig` yields

Round 7 found the hole my round-6 fix left. `syncGrokConfig` awaits
`fetchAllModels` before it ever calls `injectGrokConfig`
(`src/grok/sync.ts:37`), so the file can become orphaned in that window — by
`ocx ensure`, by `/api/grok/apply`, by a hand edit — and the route would again
report `absent` over a fence it could not touch.

A check before an `await` is a check, not a guarantee.

So the enable path re-inspects **after** the catalog resolves and immediately
before the write:

```ts
const models = await fetchCatalogForGrok(ctx);   // the awaiting part, done first
const recheck = inspectGrokConfig({ grokHome }); // authoritative: no await follows
if (recheck.kind === "orphaned_marker") return refusal(409, "orphaned_marker", ...);
return injectGrokConfig(models, ...);            // synchronous from here
```

That means WP2 calls `injectGrokConfig` directly rather than `syncGrokConfig`,
and does the catalog fetch itself — `syncGrokConfig` is precisely the wrapper
that interleaves an await between the check and the write. The catalog-building
code is small and already exported; duplicating the fence logic is what we
refuse to do, and this duplicates none of it.

`injectGrokConfig` is synchronous once entered, so nothing can slip between the
recheck and the write.

The writer is still NOT modified to propagate the orphan result. That would
change `ocx start`/`ensure` behavior for a policy skip whose own comment says it
must never block startup, and this unit has no business making that call. Other
writers — startup, `ocx ensure`, `/api/grok/apply` — keep their existing
best-effort semantics; this route is stricter than them on purpose, because a
user who clicked a switch is owed a true answer and a background sync is not.

OUT: `src/integrations/journal.ts`, `store.ts`, `ownership.ts`, `registry.ts` —
all untouched. No id widening, which also retires audit r4 #7 entirely: there is
no journal surface to widen unsafely.

## The route delegates

`stripGrokConfig()` for off, and for on the catalog build plus
`injectGrokConfig()` — the two halves `syncGrokConfig` wraps, called separately
so the orphan recheck can sit between them (§One preflight is not enough).
Neither writer is reimplemented: the guards that matter — the orphaned-marker refusal, alias
reservation, byte-for-byte preservation outside the fence, the one-time
`.bak-opencodex` — all live there and a second copy would rot.

### Preflight, before either call

```ts
// Disable only. Writing our own fence is not a shared teardown.
const owned = assertNativeTeardownOwned();
if (!owned.ok) return refusal(409, "home_mismatch", owned.message);
```

`ocx stop` has honored this since it started catching `ServiceOwnershipError`
(`src/cli/index.ts:464`); nothing on the HTTP side ever did. Without it a route
calling `stripGrokConfig` directly would pull the fence out from under a service
running from another `CODEX_HOME`/`OPENCODEX_HOME`. The refusal names both
homes and does NOT tell the user to stop a service — the trigger is a home
mismatch, not a running service (`001` §The guard I described wrong).

Every `skippedReason` maps to its own outcome (`001` §Grok):

| `skippedReason` | `ok` | Outcome | Changed the file? |
|---|---|---|---|
| `no-grok-home` | true | refusal `not_installed` | no |
| `orphaned-marker` | **false** | refusal `orphaned_marker` | no |
| `non-loopback` | true | **`non_loopback_removed` — an OUTCOME, not a refusal** | **possibly yes** |
| none, `ok:false` | false | refusal `write_failed` | no |

The first two are now produced by the inspector preflight, before any delegate
runs, so the table describes what a delegate CAN return rather than what the
route waits to discover.

`orphaned_marker` must never become `write_failed`. Nothing failed: a begin
marker without an end marker means we cannot tell where our block stops, so we
decline to guess. Telling the user to retry would be advice that cannot work.

### `non-loopback` is not a refusal (audit r5 #1)

I had this wrong and the reviewer caught it against the source. Enabling under a
non-loopback bind does NOT decline and leave the file alone. `injectGrokConfig`
calls `stripGrokConfig` first, removes any previously generated block, and only
then returns `ok: true, changed: true, skippedReason: "non-loopback"`
(`src/grok/inject.ts:352-362`).

The strip is correct and the comment above it explains why: a regenerated block
cannot carry the admission token a non-loopback bind needs without either
writing the user's secret into their own file or opening grok's credential
fallthrough, so a stale loopback block must go. But it means the operation
CHANGED the user's file, and reporting a 409 refusal — which `030` defines as
"nothing happened" — would be exactly the lie this unit exists to avoid.

So it is a 200 outcome:

```json
{ "ok": true, "clientId": "grok", "changed": true, "state": "absent",
  "reason": "non_loopback_removed",
  "message": "opencodex is bound to a non-loopback address, so Grok cannot be auto-registered. The previously generated block was removed because it pointed at a loopback address that no longer serves." }
```

`changed` reflects what `stripGrokConfig` actually reported: `true` when a stale
block was removed, `false` when there was nothing to remove. The card lands on
`absent` either way, which is the truth — Grok is not wired up.

`absent` is only correct because the orphaned-marker case can no longer reach
here: the preflight refuses it first. Without that gate, `changed: false` would
also cover "a fence we could not touch is still in the file", and `absent` would
be false (audit r6 #4).

"Can no longer reach here" means through THIS route, and only because the
recheck sits after the last await (audit r7 #1). A concurrent `ocx ensure` can
still orphan the file a millisecond later; no route-local check can prevent
that, and the next `GET` reports `unsafe` when it does.

## What the dialog must therefore say

Undo regenerates the fence rather than restoring the old bytes, so the copy in
`002` changes from "보관해 둔 파일로 되살립니다" to the truth: re-enabling
rewrites the block from the current model list. For a user that is the same
outcome — their aliases come back — but promising a byte-for-byte restore would
be a promise the writer does not make.

## Acceptance

- [ ] Disable removes only the fenced region; bytes outside it are byte-identical
      afterwards, including a trailing user section and CRLF line endings.
- [ ] Re-enable regenerates the fence and the model aliases are present again.
- [ ] Disable → enable → disable is stable: the file returns to the same
      non-fenced content each time.
- [ ] `orphaned-marker` refuses as `orphaned_marker` and writes nothing.
- [ ] `no-grok-home` refuses `not_installed`; the card reads not-installed.
- [ ] Enabling under a non-loopback bind WITH an existing fence returns 200
      `non_loopback_removed` with `changed: true`, and the fence is gone. It must
      NOT return a refusal claiming nothing changed (audit r5 #1).
- [ ] Enabling under a non-loopback bind with NO fence returns the same outcome
      with `changed: false`.
- [ ] Enabling under a non-loopback bind with an ORPHANED marker refuses
      `orphaned_marker` and never reports `absent` — the fence is still there
      (audit r6 #4).
- [ ] The inspector runs before either delegate in BOTH directions; a test
      asserts `injectGrokConfig` is not called when the marker is orphaned.
- [ ] The enable path re-inspects AFTER the catalog fetch and immediately before
      the write, with no await in between — a test orphans the file inside a
      stubbed `fetchAllModels` and asserts the route refuses rather than
      reporting `absent` (audit r7 #1).
- [ ] WP2 calls `injectGrokConfig` directly, not `syncGrokConfig`; a test
      asserts the wrapper is not on this path.
- [ ] `findManagedRegion` has exactly one definition; the inspector imports it
      rather than re-implementing the boundary scan.
- [ ] A foreign-home install-state fixture makes disable refuse `home_mismatch`
      and write nothing — the branch is reachable, not declared (audit r1 #5).
- [ ] Enabling is NOT gated by the ownership preflight.
- [ ] No journal row and no snapshot are written by this toggle.
- [ ] `bun run typecheck`, the existing Grok tests, and `privacy:scan` green.
