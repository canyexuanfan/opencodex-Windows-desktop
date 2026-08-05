# 040 — Layer 4: startup catalog write leaves stale app-servers unhandled (#1046)

## The defect

Service startup rewrites the Codex catalog and `models_cache.json`, then does
nothing about app-servers already running against the old catalog.
`afterCatalogWriteHandleAppServers()` is called only from the explicit CLI `sync`
and `sync-cache` paths (`src/cli/index.ts:858-880`).

The reporter's two-host comparison pinned it precisely: *"Host A's catalog was
rewritten 4m27s after its app-server booted, so the app-server serves an in-memory
list that no longer exists on disk. Every check we ran reads the file; the picker
renders memory."*

That is confirmed upstream. For a configured catalog, Codex builds a
`StaticModelsManager` holding an in-process `Vec<ModelInfo>`; its list operations
clone that vector and its refresh is a no-op. Rewriting either disk file cannot
move it. The gap appears twice on the startup path:
`src/server/index.ts:403-412` (cache invalidation) and
`src/cli/index.ts:319-320` → `src/codex/desired-state.ts:148-160` (catalog sync).

## The obvious fix is unsafe, and this is the important part

`afterCatalogWriteHandleAppServers()` has two branches
(`src/codex/app-server-processes.ts:725-756`):

- `restart: false` — logs a warning. No signal, no prompt, no wait.
- `restart: true` — **SIGTERMs matching app-servers**
  (`:738-742` → `:656-710`), with its own log line admitting active turns may be
  interrupted. It does not drain, and it never escalates to SIGKILL.

Wiring the `restart` branch into unattended startup would kill a user's in-flight
turn every time the service starts on login, repair, or update. A human typing
`ocx sync --restart-codex` is consenting to that; a boot is not.

There is a second trap. The existing handler warns whenever *any* matching
app-server exists — it does not check staleness. The repository already has an
mtime-based classifier that does (`:538-642`, `stale` iff
`startedAtMs <= catalogMtimeMs`). Using the blunt handler at startup would warn on
every boot with Codex open, including the common case where the app-server is
newer than the catalog and perfectly correct.

## Change map — warn only, stale only

### `src/codex/app-server-processes.ts` — ADD

A startup-safe helper beside the existing handler:

```ts
export async function warnIfStaleCodexAppServersAfterStartupWrite(
  opts: { log?: Pick<Console, "error"> } = {},
): Promise<{ warned: boolean }> {
  try {
    const state = await collectCodexAppServerCatalogState();
    if (state.state !== "stale") return { warned: false };
    (opts.log ?? console).error(formatStaleCodexAppServerWarning(state.processes));
    return { warned: true };
  } catch {
    return { warned: false };   // startup sync is best-effort; never fail boot
  }
}
```

It never reaches `restartCodexAppServers()`. That is the whole point.

`formatStaleCodexAppServerWarning` currently takes full `CodexAppServerProcess`
objects but reads only `.pid` (`:410-417`); widening its parameter to a
PID-bearing shape avoids a needless cast.

### `src/codex/desired-state.ts:148-160` — MODIFY

Call it after a startup sync that actually wrote something (`catalogWritten ||
cacheSynced`, flags from `src/codex/sync.ts:83-89`). Startup sync is explicitly
best-effort (`:141-155`) and this must not change that.

### Deliberately out of scope

`src/server/index.ts:403-412` is the second gap. It is left alone in this layer:
the cache-only invalidation is a different write with a different lifecycle, and
widening the blast radius of a first fix is how a small change becomes unmergeable.
Recorded here so the next round does not think it was missed.

## Tests

No test currently combines startup sync with app-server handling — verified by an
exhaustive read-only scan across `origin/dev`'s `tests/` for files mentioning both
`syncCodexOnStartIfEnabled|handleStart` and
`afterCatalogWriteHandleAppServers|collectCodexAppServerCatalogState`. Result:
empty.

**Add**, faking both boundaries:

1. discovery runs only when `catalogWritten || cacheSynced`;
2. stale warns, fresh and `not_running` do not;
3. **an injected `kill` that fails the test if called** — this is the assertion
   that matters, because it is the one that would catch a future refactor wiring
   the `restart` branch into boot;
4. discovery throwing still resolves startup successfully.

Existing coverage to leave intact: `tests/codex-app-server-processes.test.ts:19-106`
(classification), `:309-338` (warn vs SIGTERM), `tests/codex-desired-state.test.ts:167-205`
(startup enable/disable).

## Red-green

Test 2 fails on the pre-fix tree: startup emits no warning at all for a stale
app-server. Test 3 passes before and after by construction — it is a guard, not a
regression proof, and the doc says so rather than counting it twice.

## Accept criteria

- Startup warns only when the classifier says `stale`.
- No code path from startup can reach `restartCodexAppServers()`, proven by an
  injected `kill` that fails the test if invoked.
- Discovery failure never fails boot.
- `bun run typecheck` clean; both app-server test files pass.
