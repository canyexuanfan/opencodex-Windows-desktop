# 030 — WP3: Grok per-model selection state, sync filter, management API

No dependency on WP1/WP2; this is the backend half of the Grok switch.

## Why the switch cannot simply write TOML

`src/grok/inject.ts:186-207` refuses to auto-register for non-loopback binds, and the
comment there records why: a regenerated block cannot carry the admission token without
either writing the user's secret into `~/.grok/config.toml` or leaving `env_key` to fall
through to grok's own xAI session credential. `injectGrokConfig` also owns backup,
byte-for-byte user-content preservation, EOL detection, orphaned-marker refusal and
alias reservation. Re-implementing any of that behind an HTTP route would widen the blast
radius of a web-reachable surface.

So the switch changes **what the existing writer is asked to write**, and re-applying
calls the same `syncGrokConfig` the CLI calls. No new writer exists anywhere in this
phase.

## NEW config field — `src/types.ts`

Next to the other top-level toggles (near `subagentModelFallbackPollMs`, `:483-487`):

```ts
  /**
   * Model ids the user has EXCLUDED from the Grok Build managed block. Absent or empty
   * means "everything visible", which is the historical behaviour — so an existing
   * config keeps the fence it already had.
   *
   * Exclusion list rather than an inclusion list on purpose: a newly added provider
   * model should appear in Grok by default, exactly as it does today. An inclusion list
   * would silently hide every future model behind a switch nobody knew to flip.
   */
  grokExcludedModels?: string[];
```

`configSchema` (`src/config.ts:480-493`) is `.passthrough()`, so an unknown key already
survives a round-trip; adding an explicit `z.array(z.string()).optional()` entry makes
the contract intentional and gives a bad hand-edit a real parse error instead of a
silent pass. Add it to the schema object in the same commit.

## MODIFY — `src/grok/sync.ts`

`syncGrokConfig` currently builds `models` from every native slug plus every
catalog-visible routed model (`:33-52`). Insert a single filter step after the list is
assembled, before `deps.injectGrokConfig`:

```diff
 export async function syncGrokConfig(...) {
   let models: GrokInjectModel[];
   try {
     const routed = filterCatalogVisibleModels(await deps.fetchAllModels(config), config);
     models = [
       ...visibleNativeSlugs(config).map(...),
       ...routed.map(...),
     ];
+    // The user's per-model switches from the dashboard. An empty/absent list keeps the
+    // historical behaviour (everything visible goes into the fence).
+    models = filterGrokSelectedModels(models, config.grokExcludedModels);
   } catch (err) { ... }
   return deps.injectGrokConfig(port, models, ...);
 }
```

with the helper exported from the same module so both the route and the tests can use
it without importing the whole sync path:

```ts
/**
 * Drop excluded ids from a Grok model list.
 *
 * Pure and order-preserving: alias generation in buildGrokManagedBlock depends on list
 * order (duplicate base aliases get numeric suffixes), so reordering here would rename
 * a user's aliases behind their back.
 */
export function filterGrokSelectedModels(
  models: GrokInjectModel[],
  excluded: readonly string[] | undefined,
): GrokInjectModel[] {
  if (!excluded || excluded.length === 0) return models;
  const drop = new Set(excluded);
  return models.filter(model => !drop.has(model.id));
}
```

Edge case that must be handled, not discovered later: excluding EVERY model leaves an
empty list, and `buildGrokManagedBlock` with `models: []` emits just the two markers.
That is a valid "registered nothing" fence, and `stripGrokConfig` still removes it. The
route rejects nothing on this basis; the UI warns.

## NEW routes — `src/server/management/agent-settings-routes.ts`

Beside the existing read-only `GET /api/grok` (`:388-396`).

### `GET /api/grok` — extended payload

```diff
   if (url.pathname === "/api/grok" && req.method === "GET") {
     try {
       const { readGrokStatus } = await import("../../grok/status");
-      return jsonResponse(readGrokStatus());
+      const { fetchGrokCandidateModels } = await import("./shared");
+      // `candidates` is the full visible catalog the fence WOULD carry, so the page can
+      // show a switch for a model the user has already excluded (it is absent from the
+      // fence, so `status.models` alone could never list it).
+      return jsonResponse({
+        ...readGrokStatus(),
+        candidates: await fetchGrokCandidateModels(config),
+        excluded: config.grokExcludedModels ?? [],
+      });
     } catch (error) { ... }
   }
```

`fetchGrokCandidateModels` is a NEW helper in `src/server/management/shared.ts`,
built from the same two sources `syncGrokConfig` uses so the two can never disagree:

```ts
export interface GrokCandidateModel {
  id: string;
  contextWindow?: number;
  native: boolean;
}

/** The model list `syncGrokConfig` would inject, before the user's exclusions. */
export async function fetchGrokCandidateModels(config: OcxConfig): Promise<GrokCandidateModel[]> {
  const { filterCatalogVisibleModels, nativeOpenAiContextWindow, visibleNativeSlugs } = await import("../../codex/catalog");
  const routed = filterCatalogVisibleModels(await fetchAllModels(config), config);
  return [
    ...visibleNativeSlugs(config).map(id => {
      const contextWindow = nativeOpenAiContextWindow(id);
      return { id, native: true, ...(contextWindow !== undefined ? { contextWindow } : {}) };
    }),
    ...routed.map(m => ({
      id: m.alias ?? `${m.provider}/${m.id}`,
      native: false,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    })),
  ];
}
```

### `PUT /api/grok/selection`

```ts
  // Writes CONFIG only. ~/.grok/config.toml is still written exclusively by
  // injectGrokConfig, through the apply route below — this route cannot touch that file.
  if (url.pathname === "/api/grok/selection" && req.method === "PUT") {
    let body: { excluded?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    const raw = body.excluded;
    if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string" || entry.length === 0)) {
      return jsonResponse({ error: "excluded must be an array of model ids" }, 400);
    }
    // Dedupe and sort so the stored list is stable, and cap it so a hostile client
    // cannot grow config.json without bound.
    const excluded = [...new Set(raw as string[])].sort();
    if (excluded.length > 2000) return jsonResponse({ error: "excluded list is too large" }, 400);
    if (excluded.length === 0) delete config.grokExcludedModels;
    else config.grokExcludedModels = excluded;
    saveConfig(config);
    return jsonResponse({ ok: true, excluded });
  }
```

### `POST /api/grok/apply`

```ts
  // Re-runs the SAME sync the CLI runs. All guards (no-grok-home, non-loopback refusal,
  // orphaned marker, backup, alias reservation) live in injectGrokConfig and are not
  // duplicated here.
  if (url.pathname === "/api/grok/apply" && req.method === "POST") {
    try {
      const { syncGrokConfig } = await import("../../grok/sync");
      const port = Number(url.port) || config.port;
      const result = await syncGrokConfig(port, config, config.hostname ? { hostname: config.hostname } : {});
      // A policy skip (non-loopback, no ~/.grok) is not a server error: report it as a
      // result the page can explain rather than a 500 the user cannot act on.
      return jsonResponse({ ok: result.ok, changed: result.changed, message: result.message,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}) }, result.ok ? 200 : 500);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }
```

Security note for review: both new routes ride the existing management-API auth/CORS
boundary (`handleManagementAPI` → `handleAgentSettingsRoutes`), the same one that
already carries `PUT /api/claude-desktop` and `POST /api/claude-desktop/apply`. No new
auth surface, no credential handling, no request-body logging.

## TESTS

`tests/grok-selection.test.ts` (NEW):

- `filterGrokSelectedModels` with no list returns the input array unchanged
  (identity-ish, order preserved);
- excluding one id drops exactly that id and keeps order;
- excluding an unknown id is a no-op;
- excluding everything yields `[]`, and `injectGrokConfig(port, [])` writes a fence with
  the two markers and no `[model.` table — **activation evidence** for the empty case
  (C-ACTIVATION-GROUNDING-01);
- `syncGrokConfig` with `grokExcludedModels` set omits that model's table from the
  written TOML while keeping the others (uses the `tempGrokHome` helper pattern from
  `tests/grok-sync.test.ts`).

Extend `tests/claude-management-api.test.ts` style coverage in a NEW
`tests/grok-management-api.test.ts`:

- `PUT /api/grok/selection` with a non-array body → 400;
- with `["a","a","b"]` → 200, stored value `["a","b"]`, and `loadConfig()` reflects it;
- with `[]` → the field is REMOVED from config (not stored as an empty array);
- `GET /api/grok` includes `candidates` and `excluded`;
- `POST /api/grok/apply` in a temp `GROK_HOME` with no `.grok` directory returns
  `ok: true` with `skippedReason: "no-grok-home"` — the guard fires and is observed.

Guard test (NEW, `tests/grok-writer-boundary.test.ts`) — the criterion `c-grok-guard`
needs a mechanical check, not a promise:

- read `src/server/management/agent-settings-routes.ts` and assert it contains no
  `atomicWriteFile`/`writeFileSync` reference in the Grok region, and that the only
  Grok write path it imports is `syncGrokConfig`;
- `rg`-equivalent assertion that `config.toml` is written only from `src/grok/inject.ts`.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/grok-selection.test.ts tests/grok-management-api.test.ts tests/grok-writer-boundary.test.ts tests/grok-sync.test.ts tests/grok-config-inject.test.ts` | pass |
| `bun run typecheck` | clean |
| `bun run privacy:scan` | clean |
