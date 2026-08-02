# 010 — WP1: the config.toml read/write core

New file: `src/codex/prompt-layers.ts`. No GUI, no route. Pure module + tests.

`004` §E: `features.ts` forbids broadening itself beyond `multi_agent_v2`, so
this is a sibling module that copies its technique rather than an extension of
it.

## Exports

```ts
export type LayerId =
  | "permissions" | "collaboration" | "environment" | "apps" | "skills";

export interface LayerState {
  id: LayerId;
  key: string;            // "include_permissions_instructions" | "skills.include_instructions"
  configured: boolean | null;  // null = key absent
  effective: boolean;          // configured ?? default
  default: boolean;            // always true for all five (001 §2)
}

export interface CustomLayer {
  id: string;             // 6-char base36, stable across edits
  title: string;
  body: string;
  enabled: boolean;
}

export interface PromptLayerSnapshot {
  configPath: string;
  configExists: boolean;
  readable: boolean;
  layers: LayerState[];
  custom: CustomLayer[];
  unownedDeveloperInstructions: string | null;
  modelInstructionsFile: string | null;   // read-only warning surface (002 §3)
}

export function readPromptLayers(configPath?: string): PromptLayerSnapshot;
export function setLayerEnabled(id: LayerId, enabled: boolean, configPath?: string):
  { ok: true; changed: boolean } | { ok: false; error: string };
export function writeCustomLayers(layers: CustomLayer[], configPath?: string):
  { ok: true; changed: boolean } | { ok: false; error: string };
```

## Key allowlist — fixed, never computed

```ts
const LAYER_KEYS: Record<LayerId, { table: string | null; key: string }> = {
  permissions:   { table: null,     key: "include_permissions_instructions" },
  collaboration: { table: null,     key: "include_collaboration_mode_instructions" },
  environment:   { table: null,     key: "include_environment_context" },
  apps:          { table: null,     key: "include_apps_instructions" },
  skills:        { table: "skills", key: "include_instructions" },
};
```

`003` §5: an unknown key is silently ignored in normal mode and a hard startup
error under `--strict-config`. A fixed table means the GUI can never emit a key
it did not intend. `setLayerEnabled` rejects any id outside this map before
touching the file.

## Read

1. Resolve the path exactly as `features.ts:58-67` does — `CODEX_HOME` at call
   time, `~` expansion, `realpathSync.native` when it resolves.
2. Missing file → `configExists: false`, `readable: true`, every layer
   `configured: null`, `effective: true`. Not an error; `005` renders defaults.
3. Unreadable → `readable: false` and the panel refuses to write.
4. For each of the five keys, scan the correct scope: root keys only outside any
   `[table]` header; `skills.include_instructions` only inside `[skills]`.
   Reuse the table-body bounding from `features.ts:269-290`.
5. **Absent key means `configured: null`, never `false`.** `001` §6 — this
   surface is four months old and still moving; absence is unknown, not off.
6. Parse `developer_instructions` into custom layers via the fence scanner
   below; anything outside a fence becomes `unownedDeveloperInstructions`.
7. Read `model_instructions_file` for the read-only warning row.

## Write

Same discipline as `features.ts:248-310`:

- refuse unreadable input rather than creating a fresh file over it;
- `dominantEol` before, `applyEol` after;
- edit the line array, never re-serialize the document;
- confine matching to the owning table body;
- idempotent — equal value returns `changed: false` and writes nothing;
- `atomicWriteFile` only when something changed.

Root-key insertion goes at the document top, before the first `[table]` header,
because a root key placed after one belongs to that table. `inject.ts:162`
already establishes the top-of-document convention.

`[skills]` is created only when setting the skills layer and the table is
absent, appended at end of document.

## The fence format

```
# >>> ocx-layer:<id> <title>
<body>
# <<< ocx-layer:<id>
```

- `id`: `[a-z0-9]{6}`. A malformed id fails the scan for that block, which is
  then treated as unowned text — never silently rewritten.
- Title is stored on the opening fence. A title containing a newline is
  rejected at write time.
- Body is verbatim between the fences.
- A disabled layer is stored but omitted from the composed string; its body is
  kept in a sibling `[skills]`-style opencodex block? **No** — see below.

### Where disabled bodies live

A disabled layer must survive a round-trip without being injected. Options
considered:

1. Keep it fenced inside `developer_instructions` with a disabled marker —
   rejected: Codex would inject the text, because the whole string is the
   prompt.
2. Store it in a separate opencodex-owned file.

**Decision: option 2.** `$CODEX_HOME/.opencodex-prompt-layers.json` holds the
full custom-layer list including bodies and enabled flags;
`developer_instructions` holds only the composed enabled subset. The JSON file
is the source of truth for the editor, config.toml is the source of truth for
what Codex sees, and `readPromptLayers` reconciles them: a layer present in
config.toml but absent from JSON is adopted as enabled; a JSON layer missing
from config.toml is treated as disabled.

This keeps disabled text out of the prompt while still making it recoverable,
which is exactly what "스위치를 껐다 킬 수 있고" requires.

## Unowned text is untouchable

If `developer_instructions` exists with no fences, it was written by the user or
another tool. It is preserved as a prefix ahead of the composed block and never
edited or deleted. Same rule as `injected-marker.ts:53-60`: without our marker,
it is not ours.

## Tests — `tests/codex-prompt-layers.test.ts`

Every case takes an explicit temp `configPath` (`004` §H: never resolve the real
`CODEX_HOME`).

1. missing file → defaults, `configExists: false`
2. unreadable file → `readable: false`, writes refused
3. absent key → `configured: null`, `effective: true`
4. `include_apps_instructions = false` → configured false, effective false
5. `[skills] include_instructions = false` read from the table, not root
6. a root-looking key **inside** another table is NOT read as the root key
7. set → insert at top of document, above the first `[table]`
8. set on an existing key → replace in place, comments intact
9. idempotent set → `changed: false`, file byte-identical
10. CRLF file stays CRLF
11. unrelated tables, comments, and blank lines survive a write
12. custom layers round-trip through the fences
13. unowned `developer_instructions` preserved as prefix
14. disabled layer omitted from config.toml, retained in JSON
15. malformed fence treated as unowned, never rewritten
16. an id outside the allowlist is rejected before any file access
17. `model_instructions_file` surfaces when present

Cases 6, 11, 13, and 15 are the ones that protect user data; each must be driven
red once before it is trusted.

## Not in this phase

No route, no GUI, no presets, no linter. WP1 ships a module and its tests.
