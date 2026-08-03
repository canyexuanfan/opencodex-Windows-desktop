# WP2 — Grok Build

> **Rev 2** after audit round 4 (`007_audit_synthesis_r4.md`). The journal and
> snapshot machinery is GONE from this phase. Round 4 forced the question I had
> been avoiding: what is Grok's undo, actually?

## Undo is the enable path

Turning Grok back on runs `syncGrokConfig(port, config)`, which regenerates the
fence from the current catalog. That is the undo. It is also strictly better
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
4. `tests/native-grok-toggle.test.ts` — NEW.

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

`findManagedRegion` becomes module-internal-shared rather than duplicated: two
parsers for one fence is how a strip eventually removes the wrong bytes.

**GET is advisory.** The reviewer is right that a file can change between the
GET and the PUT, so `disableBlocked` cannot promise the PUT will succeed. PUT
re-runs every preflight while holding `client:grok`, and its refusal is
authoritative. `disableBlocked` exists to avoid offering an action we already
know is blocked — not to replace the check.

OUT: `src/integrations/journal.ts`, `store.ts`, `ownership.ts`, `registry.ts` —
all untouched. No id widening, which also retires audit r4 #7 entirely: there is
no journal surface to widen unsafely.

## The route delegates

`stripGrokConfig()` for off, `syncGrokConfig(port, config)` for on. Neither is
reimplemented: the guards that matter — the orphaned-marker refusal, alias
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
- [ ] A foreign-home install-state fixture makes disable refuse `home_mismatch`
      and write nothing — the branch is reachable, not declared (audit r1 #5).
- [ ] Enabling is NOT gated by the ownership preflight.
- [ ] No journal row and no snapshot are written by this toggle.
- [ ] `bun run typecheck`, the existing Grok tests, and `privacy:scan` green.
