# 010 — WP1: the config.toml read/write core

New file: `src/codex/prompt-layers.ts`. No GUI, no route. Pure module + tests.

`004` §E: `features.ts` forbids broadening itself beyond `multi_agent_v2`, so
this is a sibling module that copies its technique rather than an extension of
it.

## Exports

```ts
/** Classes A-E from 001 §4. The partition is total and disjoint. */
export type LayerClass =
  | "base" | "config-toggle" | "feature-gated"
  | "runtime-conditional" | "extension-unknown";

export type ToggleId =
  | "permissions" | "collaboration" | "environment" | "apps" | "skills";

/** The canonical inventory. ONE definition, consumed by route and GUI alike. */
export interface LayerDescriptor {
  id: string;
  class: LayerClass;
  /** config key for config-toggle and feature-gated; null otherwise */
  key: string | null;
  /** documented default when the key is absent */
  default: boolean | null;
  /** assembly index from 001 §1; null when registration-order dependent */
  order: number | null;
}
export const LAYER_INVENTORY: readonly LayerDescriptor[];

export interface ToggleState {
  id: ToggleId;
  key: string;
  /** null = key absent from the user file */
  userFileValue: boolean | null;
  /** userFileValue ?? default. NOT the resolved Codex value — see below. */
  defaultedUserValue: boolean;
  default: boolean;
}

export interface CustomLayer {
  id: string;             // [a-z0-9]{6}, stable across edits
  title: string;
  body: string;
  enabled: boolean;
}

export interface PromptLayerSnapshot {
  configPath: string;
  storePath: string;
  configExists: boolean;
  readable: boolean;
  /** false when developer_instructions exists without our marker */
  developerInstructionsOwned: boolean;
  toggles: ToggleState[];
  custom: CustomLayer[];
  modelInstructionsFile: string | null;   // read-only warning (002 §3)
  /** SHA-256 over store bytes + developer_instructions + the five booleans */
  revision: string;
}

export type WriteResult =
  | { ok: true; changed: boolean; snapshot: PromptLayerSnapshot }
  | { ok: false; error: WriteError };

export type WriteError =
  | "config_unreadable" | "stale_revision" | "developer_instructions_not_owned"
  | "unknown_layer" | "reparse_failed" | "store_unreadable";

export function readPromptLayers(opts?: Paths): PromptLayerSnapshot;
export function setToggle(id: ToggleId, enabled: boolean, revision: string, opts?: Paths): WriteResult;
export function writeCustomLayers(layers: CustomLayer[], revision: string, opts?: Paths): WriteResult;
```

### `defaultedUserValue`, not `effective`

The audit caught the first draft calling `configured ?? default` the *effective*
value. It is not. `003` §1 lists eight layers above the user file — profile-v2,
project config, CLI `-c`, thread layers, MDM — any of which can win.

opencodex reads one file, so it can only report what that file says. The field
is named for what it actually is, and the UI says "이 파일의 설정" rather than
claiming the running Codex agrees. `003` §6's managed-override notice is
**deferred**: promising override detection without a read path would be the same
overclaim in a different place.

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
2. Missing file → `configExists: false`, `readable: true`, every toggle
   `userFileValue: null`. **Writes are allowed and create the file** — see
   "First write" below. The audit was right that a disabled switch plus a
   "created on first change" note is a contradiction.
3. Unreadable → `readable: false` and every write refused.
4. For each of the five keys, scan the correct scope: root keys only outside any
   `[table]` header; `skills.include_instructions` only inside `[skills]`.
   Reuse the table-body bounding from `features.ts:269-290`.
5. **Absent key means `configured: null`, never `false`.** `001` §6 — this
   surface is four months old and still moving; absence is unknown, not off.
6. Custom layers come from `opencodex-prompt.json`, never from parsing
   `developer_instructions`. Determine `developerInstructionsOwned` by the
   marker-adjacency rule.
7. Read `model_instructions_file` for the read-only warning row.
8. Compute `revision`.

## First write

When `config.toml` is absent, the first mutation creates it:

- `mkdir -p` the parent with mode `0700`, matching how Codex itself treats
  `$CODEX_HOME`;
- write a minimal file containing only the marker and the key being set;
- `0600` on the file — it sits beside `auth.json`.

A missing file is a first run, not an error state. `040` therefore renders live
switches, not disabled ones.

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

## Storage — redesigned after audit

The first draft fenced layer bodies inside the `developer_instructions` TOML
string and kept disabled bodies in a sidecar JSON. An independent audit killed
it on four counts, all correct:

- **TOML encoding.** "Body is verbatim" is false inside a multiline basic
  string. A body containing `"""` terminates the value; a backslash is an escape.
  Arbitrary user prose would produce malformed TOML — and `003` §4 shows Codex
  cannot then parse the file at all.
- **Fence collision.** A body containing `# <<< ocx-layer:...` splits or steals
  its own block.
- **Two-file reconciliation.** Presence/absence rules do not say which side wins
  for body, title, or order, and deleting the JSON silently loses every disabled
  body.
- **Concurrency.** Two GUI tabs, or Codex writing between our read and write,
  lose updates. Atomic rename prevents torn bytes, not stale overwrites.

### The fix: one owned file, one generated key

**`$CODEX_HOME/opencodex-prompt.json` is the single source of truth** for custom
layers — every layer, enabled or not, with body, title, and order.

`config.toml` receives exactly one generated root key, written through a real
TOML serializer:

```toml
# Auto-injected by opencodex
developer_instructions = "...properly escaped composition of enabled layers..."
```

Consequences that dissolve three blockers at once:

- **No fences.** Bodies are joined with `\n\n` and never carry structure that
  has to survive a round trip through TOML. The value is write-only from our
  side; we never parse it back to recover layer identity.
- **Encoding is a solved problem.** We emit through a serializer that escapes
  `"`, `\`, and control characters, and we assert the result re-parses. No body
  can produce malformed TOML.
- **Reconciliation disappears.** There is exactly one authority. `config.toml`
  is a *projection*, never a source.

### Serializer and parser

Bun ships no TOML writer, and hand-rolling escapes is what created blocker 1.
WP1 uses `smol-toml` (pure TS, MIT, ~30 KB) for two narrow jobs:

1. `parse()` to locate the exact value span of `developer_instructions` and to
   read the five boolean keys' *values* for verification.
2. `stringify()` of a single-key document to produce a correctly escaped literal
   for the composed string.

The five boolean toggles keep the `features.ts:248-310` scoped line edit —
booleans need no escaping, and line editing preserves the user's comments and
formatting exactly. The parser is used only to **verify** the write re-parses to
the intended value.

So: line edits for booleans, serializer for the one string key, parse-check
after every write. If the reparse disagrees with the intent, the write is rolled
back and an error returned rather than leaving a file Codex cannot load.

### Ownership and unowned text

`developer_instructions` is ours only when the immediately preceding line is
`OCX_SECTION_MARKER` — the same adjacency rule as
`injected-marker.ts:53-60`.

- **Marker present** → we own the key and rewrite its value freely.
- **Marker absent, key present** → the user or another tool wrote it. We do
  **not** touch it. Custom layers are refused with `developer_instructions_not_owned`
  and the UI explains that the key is externally managed.

This is stricter than the first draft's "preserve as a prefix", and deliberately
so. The audit is right that we cannot reliably rewrite the value of a key whose
string form we did not choose — it may be a literal string, a single-line basic
string, or dotted. Refusing is honest; guessing corrupts.

If a user wants opencodex to manage the key, they clear it themselves. That is a
one-time manual step, stated plainly, instead of a class of silent data loss.

### Concurrency

`readPromptLayers` returns a `revision`: a SHA-256 over the JSON file bytes plus
the `developer_instructions` value plus the five boolean values.

Every mutation carries the revision it was based on. A mismatch is refused with
`stale_revision` and the caller re-reads. `020` maps this to `409`.

Write order, with an in-process mutex serializing local callers:

1. take the lock
2. re-read, compare revision → refuse on mismatch
3. write JSON atomically (source of truth first)
4. write config.toml atomically (projection second)
5. reparse config.toml; on failure, restore the previous bytes and error
6. release

A crash between 3 and 4 leaves the JSON ahead of config.toml. That is the
**recoverable** direction: the next read detects the drift and re-projects. The
reverse order would leave the prompt containing a layer we no longer have a body
for, so the ordering is load-bearing, not incidental.

## Tests — `tests/codex-prompt-layers.test.ts`

Every case takes explicit temp paths (`004` §H: never resolve the real
`CODEX_HOME`).

**Reading**
1. missing config → defaults, `configExists: false`, writes still permitted
2. unreadable config → `readable: false`, every write refused
3. absent key → `userFileValue: null`, `defaultedUserValue: true`
4. `include_apps_instructions = false` → both false
5. `[skills] include_instructions` read from its table, not root
6. a root-looking key **inside** another table is not read as the root key

**Boolean writes**
7. insert above the first `[table]`
8. replace in place, comments intact
9. idempotent → `changed: false`, file byte-identical
10. CRLF preserved
11. unrelated tables, comments, blank lines survive
12. unknown id rejected before any file access
13. first write creates file and parent with `0700`/`0600`

**Encoding — the blocker-1 set**
14. body containing `"""` round-trips and the file re-parses
15. body containing `\`, `\n`, `\t`, and a trailing backslash
16. body containing NUL and other control characters
17. body containing CRLF
18. body containing non-BMP Unicode and combining marks
19. body containing the old fence text `# >>> ocx-layer:abc123` — now inert
20. a 64 KiB body
21. **after every write in 14-20, `smol-toml` re-parses the file and the value
    equals the intended composition** — the property that makes 14-20 meaningful

**Ownership**
22. marker-adjacent key → owned, rewritten
23. key without marker → `developer_instructions_not_owned`, file untouched
24. key as a literal string without marker → same refusal, no corruption
25. our marker survives an unrelated boolean write

**Store and concurrency**
26. custom layers round-trip through JSON
27. disabled layer stays in JSON, absent from the composed value
28. all layers disabled → key removed entirely, marker removed with it
29. JSON missing → treated as empty, config.toml re-projected on next write
30. JSON malformed → `store_unreadable`, config.toml untouched
31. stale revision → `stale_revision`, nothing written
32. concurrent writers: second stale PUT refused, first survives
33. simulated crash between JSON and TOML writes → next read re-projects
34. reparse failure rolls back to the previous bytes

Cases 6, 11, 19, 21, 23, 31, and 33 are the data-protection set. Each is driven
red once before it is trusted.

## Not in this phase

No route, no GUI, no presets, no linter. WP1 ships a module and its tests.
