# WP3 — the routes the cards call

> **Rev 5** after audit round 4 and the re-scope (`007`). The unit is now Claude
> Code and Grok only, and neither writes a journal row or a snapshot — so the
> journal route, the restore route, the `partial` response and every
> snapshot-shaped field are GONE. What survives is the status read, the two
> PUTs, the refusal envelopes and the coordinator. This is WP3.

## IN

1. `src/server/management/native-integration-routes.ts` — NEW.
2. `src/server/management-api.ts` — MODIFY: mount it.
3. `tests/native-integration-routes.test.ts` — NEW.
4. `src/integrations/mutation-lock.ts` — NEW: the coordinator.
5. `src/server/management/integration-routes.ts` — MODIFY: its existing
   per-client flight map is replaced by the coordinator, preserving the same
   busy-409 behavior.
6. `tests/integration-mutation-lock.test.ts` — NEW.

OUT: `/api/client-integrations/*` — the six file clients keep their routes
unchanged. `/api/claude-code` and `/api/claude-desktop/*` stay for the pages that
own the detailed settings; this module is the toggle surface only.

## Why a new module rather than more branches in `agent-settings-routes.ts`

That file is already ~1100 lines carrying Grok selection, Desktop profiles,
Claude Code settings, subagent flags and feature toggles. Four more branches
would be four more reasons to open it. The new module has one job — enable and
disable a native integration — and its tests can say so.

## Surface

```
GET  /api/native-integrations          → { clients: NativeStatus[] }
PUT  /api/native-integrations/:client  { enabled: boolean }   // claude | grok
```

**There is no restore route.** Undo for both clients is the PUT in the other
direction: Claude Code flips its flag back, Grok regenerates its fence. A
`/restore` endpoint would imply an operation record neither client keeps, and
four audit rounds went into establishing they do not need one. The Rollback
Centre continues to serve the six file clients only.

`GET` also carries each client's non-mutating preflight result, so the GUI can
disable a switch that would be refused instead of opening a dialog and then
failing (audit r4 #8):

```ts
interface NativeStatus {
  clientId: "claude" | "grok";
  state: "absent" | "current" | "unsafe";
  installed: boolean;
  configPath: string;
  /** Non-null when a disable would be refused right now, with the reason. */
  disableBlocked: { reason: NativeRefusalReason; message: string } | null;
}
```

`GET` composes the four reads the overview already makes separately today
(`/api/startup-health`, `/api/claude-code`, `/api/claude-desktop/status`,
`/api/grok`) into one payload shaped like the file clients':

```ts
interface NativeStatus {
  clientId: NativeIntegrationClientId;
  state: "absent" | "current" | "stale" | "unsafe";
  installed: boolean;
  configPath: string;
  appliedAt?: string;
  snapshotCount: number;
}
```

The GUI keeps its five separate reads for the DETAIL lines it already renders
(auth mode, model count) and uses this one for the switch state, so WP4 is not
forced to rewrite the row model shipped this morning.

## Refusal envelopes

Same shape as the file clients', because the GUI already has
`describeRefusal` and `isIntegrationRefusalEnvelope` for it. Reusing the shape
means the dialog and the notice area need no second code path.

| HTTP | `code` | `reason` | Trigger |
|---|---|---|---|
| 409 | `native_integration_refused` | `orphaned_marker` | Grok begin marker without an end marker |
| 409 | `native_integration_refused` | `home_mismatch` | installed service's recorded home differs (raised by the WP1 preflight, not by the CLI path) |
| 409 | `native_integration_refused` | `non_loopback` | Grok auto-registration outside loopback |
| 404 | `native_integration_refused` | `not_installed` | client absent |
| 500 | `native_integration_failed` | `write_failed` | genuine IO failure, nothing changed |

`orphaned_marker` and `home_mismatch` are 409, not 500: nothing failed, we
declined. A 500 would tell the GUI to say "try again", which is precisely the
wrong advice for both.

`stripGrokConfig` writes atomically and Claude Code writes one config field, so
neither client has a half-applied state to report. The `partial` outcome earlier
revisions carried belongs to the sibling unit, where Codex and Desktop can
genuinely produce one.

## Concurrency: one coordinator, not two flight maps

Rev 1 said "different clients may proceed concurrently: they write different
files". That is false for the shared bookkeeping (audit #6). `journal.jsonl`,
`maintenance.json` and opencodex's own `config.json` are read-modify-written by
BOTH the existing file-client routes and these new ones — and the GUI already
serializes its bulk disable for exactly this reason
(`IntegrationsOverview.tsx:238-267`, which documents a lost ownership record).

Adding a second independent per-client map would leave the two route families
unaware of each other, which is worse than today.

So: one coordinator in `src/integrations/mutation-lock.ts`, used by
`integration-routes.ts` AND the native routes, keyed by resource rather than by
client.

### The API makes ordering unbypassable

```ts
export type LockKey =
  | `client:${string}`
  | "store:journal"
  | "store:records"
  | "config:ocx";

/**
 * The ONLY way to take locks. Callers pass an unordered set; this sorts it.
 *
 * A "fixed order" that callers are trusted to follow is a convention, and the
 * next caller breaks it. Sorting inside the primitive makes a hold-and-wait
 * cycle unconstructible: every holder acquires in the same total order, so
 * there is no pair that can each hold what the other wants.
 */
export async function withLocks<T>(keys: readonly LockKey[], fn: () => Promise<T>): Promise<T>;
```

Canonical total order: resource class first — `store:journal` < `store:records`
< `config:ocx` < `client:*` — then lexical within `client:*`. There is no
single-key `acquire`, so no caller can take one lock and then discover it needs
another.

### What each operation holds

| Operation | Keys |
|---|---|
| File client apply/disable/restore | `store:journal`, `store:records`, `client:<id>` |
| Grok toggle | `client:grok` |
| Claude Code toggle | `config:ocx`, `client:claude` |

Neither native toggle takes `store:journal` any more — they write no rows. Grok
keeps `client:grok` so two disables cannot race the same file; Claude Code takes
`config:ocx` so it serializes against other integration-owned config writes.

### Duplicates and reentrancy

`withLocks` sorts AND deduplicates (audit r3 #8) — sorting alone does not stop a
caller passing the same key twice and self-deadlocking on a non-reentrant mutex.
Nested `withLocks` calls with overlapping sets throw deterministically rather
than hanging; every operation above is flat, so no legitimate caller nests.

Two different file clients still write their own files in parallel and serialize
only where they share state. A Desktop disable and a Claude Code disable
serialize on `config:ocx`. Each lock is held until bookkeeping completes, not
just until the file write returns.

### Scope of the `config:ocx` claim

Rev 2 said `config:ocx` is held by "any route saving config". That was not true
and not achievable in this unit: `agent-settings-routes.ts` alone calls
`saveConfigPreservingClaudeCode` at roughly nine sites (149, 247, 456, 491, 593,
635, 692, 737, 758), none of which this unit touches.

Narrowed honestly: **`config:ocx` serializes integration-owned config writes** —
the native toggles and nothing else. Racing an unrelated settings save remains
possible and is pre-existing behavior this unit neither creates nor fixes.
Migrating the other writers is recorded as follow-up in `000` rather than
claimed here.

The file-client route's existing behavior is preserved: it keeps its per-client
busy 409, now expressed through the coordinator.
## Acceptance

- [ ] `PUT` both directions for each of the two returns its outcome status.
- [ ] Each refusal row above returns its exact status, `code` and `reason`.
- [ ] No route in this module appends a journal row or writes a snapshot.
- [ ] `GET` carries `disableBlocked` when a disable would be refused, so the GUI
      never opens a dialog for an action that cannot succeed (audit r4 #8).
- [ ] Concurrent PUTs to the SAME client: the second gets 409 busy.
- [ ] A Claude Code PUT and a file-client PUT running together do not lose each
      other's config write.
- [ ] `withLocks` sorts its input: a test passes the same keys in two different
      orders and asserts identical acquisition sequences.
- [ ] `withLocks` deduplicates: a duplicate key does not self-deadlock.
- [ ] A nested overlapping acquisition throws rather than hanging.
- [ ] There is no exported single-key acquire.
- [ ] `home_mismatch` is produced by a real foreign-home install-state fixture.
- [ ] `GET` reports `installed: false` for an absent client rather than erroring.
- [ ] `bun run privacy:scan` clean — no config content or key in any response.
