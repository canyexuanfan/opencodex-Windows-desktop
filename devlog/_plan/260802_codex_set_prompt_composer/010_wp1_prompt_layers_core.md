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

### Why no prompt text goes into config.toml at all

Round 2 of the audit rejected the `smol-toml` plan on six counts, and a live
experiment on this machine settled the question harder than the audit could.

**Measured on Bun 1.3.14, `Bun.TOML.parse`:**

| Input | Decodes to | Correct? |
|---|---|---|
| `"a\tb"` | `a\fb` | **no — tab becomes form-feed** |
| `"a\fb"` | `a\tb` | **no — form-feed becomes tab** |
| `"a\u0007b"` | `SyntaxError` | **no — valid TOML rejected** |
| `'''\nx'''` | `\nx` | **no — spec requires trimming the first newline** |

`\n`, `\r`, `\b`, `\\`, `\"`, `\uXXXX` for printable code points, and non-BMP
text all round-trip correctly. But three defects are fatal to a verify-by-reparse
design: two escapes are transposed, one legal escape is refused, and multi-line
literal trimming is not implemented.

The consequence is not "pick a different parser". It is that **we cannot verify
what Codex will read.** Codex parses with Rust `toml_edit`; we would verify with
Bun or with a JS library. An encoding tuned to satisfy our verifier is exactly
the encoding that can diverge in Codex's. A reparse check against a parser with
known-transposed escapes is worse than no check, because it reports success.

Adding `smol-toml` does not fix this either. The audit was right on every
procedural count — it is BSD-3-Clause and not MIT as an earlier draft claimed,
it is absent from `package.json` and `bun.lock`, its `parse()` returns values
and not source spans so the "locate the exact value span" claim was unsupported,
and a new production dependency triggers the security review that
`AGENTS.md` requires and no phase owned.

### The design that removes the problem

**No user-authored prose is ever written into `config.toml`.**

Custom layers live in `$CODEX_HOME/opencodex-prompt.md` — a plain UTF-8 markdown
file that opencodex owns outright. `config.toml` receives one generated line:

```toml
# Auto-injected by opencodex
model_instructions_file = "/Users/x/.codex/opencodex-prompt.md"
```

No — see the next paragraph. That key replaces the base prompt (`002` §3), which
is the thing this unit exists to avoid.

`developer_instructions` accepts only a string, so an external file is not an
option for it. Therefore the composed value **must** be encoded into TOML, and
the encoding must be one whose correctness does not depend on any parser we
control.

**Resolution: restrict the writable body character set.**

A body is accepted only if it consists of printable Unicode, spaces, `\n`, and
`\t`. Tabs are normalized to four spaces at save time — a prompt loses nothing,
and the transposition defect disappears with the character. Everything else is
rejected at the API with a precise message.

Within that set, TOML basic-string encoding is trivially total: escape `"` and
`\`, emit `\n` for newline, pass every other character through. Three escapes,
all unambiguous, none in the defective set. CRLF is normalized to LF on the way
in, so `\r` never appears.

Verification is then a **byte-level** assertion rather than a semantic one: the
emitted line must equal `key = "` + escaped + `"`, and re-reading the file must
yield that exact line. No TOML parser is involved on the write path, which means
no parser's defects can hide a divergence.

This costs the user the ability to put a NUL or a bell character in a prompt.
That is not a real loss, and it buys a guarantee that a dependency plus a
reparse could not.

### Canonical physical form

Audit blocker 5 asked for one canonical representation so replacement is a known
edit rather than a span search. It is exactly this, always:

```
<OCX_SECTION_MARKER>
developer_instructions = "<escaped, single line>"
```

Two lines, at the top of the document, above the first `[table]`. The value is
always a single-line basic string — never multi-line, never literal. Replacement
is: find the marker, replace the following line. If the line after the marker
does not match `/^developer_instructions = "/`, we do not own it and refuse.

The five boolean toggles keep the `features.ts:248-310` scoped line edit.
Booleans need no escaping at all.

### Ownership, and the takeover flow

`developer_instructions` is ours only when the immediately preceding line is
`OCX_SECTION_MARKER` and the line itself matches the canonical form — the
adjacency rule from `injected-marker.ts:53-60`, tightened by a shape check.

- **Marker present, canonical shape** → owned; rewrite freely.
- **Marker present, shape differs** → refuse. Something edited our line into a
  form our replacement rule does not cover.
- **Marker absent, key present** → externally authored. Refuse to write, and
  offer the takeover below.

We cannot safely rewrite a value whose string form we did not choose: it may be
literal, multi-line, or dotted, and `Bun.TOML.parse` cannot be trusted to decode
it (see §Why no prompt text goes into config.toml at all). Refusing is honest.

**But refusing alone is a dead end**, which is what audit blocker 5 objected to
in round 2 — the earlier answer was "the user clears it themselves", i.e. delete
your existing instructions by hand. That is not a feature.

**Takeover (`POST /api/codex-prompt/adopt`):**

1. read the raw source line, verbatim, without decoding it
2. show it to the user exactly as it appears in the file, alongside a plain
   statement of what adoption will do
3. on explicit confirmation, and only then:
   - write the raw text into `opencodex-prompt.json` as one custom layer titled
     "Imported from config.toml", enabled
   - replace the original two lines with the canonical owned form, through the
     journal transaction every other write uses
4. offer a copy button first, so the user can keep a copy outside opencodex

If the existing value cannot be read as a single-line basic string — the only
form we can extract without a trustworthy parser — adoption is refused with the
file path and line number, and the user is told to move the text manually. That
is a narrower dead end than before, and it names exactly where to look.

Nothing is deleted without confirmation, and the original text is shown before
anything is changed.

### Revision — hashes the edit base, not a summary of it

Audit blocker 4 found the first revision covering too little: removing the
marker while leaving the value unchanged produced an identical hash, so an
ownership change was invisible.

`revision` is now SHA-256 over the **complete bytes** of both files plus their
existence flags:

```
sha256( "cfg:" + (configExists ? configBytes : "\0absent") + "\n" +
        "store:" + (storeExists ? storeBytes : "\0absent") )
```

Hashing whole bytes rather than extracted values covers marker presence, key
position, reformatting, comment changes, and file creation or deletion in one
construct. It is also the exact base the edit is computed from, which is what
makes the compare-then-write meaningful.

### The transaction

Blocker 2 was correct and serious: JSON-first meant a failed request had already
mutated the source of truth. Blocker 3 was correct that "the next read
reprojects" made GET a mutating operation.

Both are fixed by a journal, and by never letting a read write.

**Files:**

| Path | Role |
|---|---|
| `opencodex-prompt.json` | source of truth for custom layers |
| `opencodex-prompt.journal` | present only during a mutation |
| `config.toml` | Codex's file; carries the generated projection |

**Write, under an advisory lock (below):**

1. acquire the lock
2. re-read both files; compare `revision` → `stale_revision` on mismatch
3. write the journal: intended JSON bytes, intended config.toml bytes, and the
   pre-image of both. `fsync`, then rename into place — the journal's existence
   is the commit point
4. write `config.toml` atomically
5. write `opencodex-prompt.json` atomically
6. delete the journal
7. release

**config.toml is written first now, not second.** With a journal the ordering
question changes: whichever file is written first, the journal already records
both intended states, so recovery is deterministic either way. Writing the
projection first means that if step 5 fails, the recorded pre-image restores
config.toml and the source of truth was never touched — a failed request leaves
*nothing* changed, which is the semantics blocker 2 demanded.

**Recovery — at service start and at lock acquisition, never in a GET:**

- journal present, both targets already match its post-image → delete it, done
- journal present, either target does not match → rewrite both from the
  post-image, then delete
- journal present but itself truncated or unparseable → restore both from the
  pre-image if it is intact; otherwise leave every file untouched and report
  `recovery_required`

If rollback itself fails, nothing further is attempted and `recovery_required`
is returned with both paths named. Silent best-effort repair on a file the user
also edits is worse than an honest stop.

### Reads never write

`readPromptLayers` is pure. When it observes drift — a journal present, or
config.toml's projection disagreeing with the JSON — it reports
`drift: "journal-present" | "projection-stale" | null` and changes nothing.

`020` surfaces drift as a state the GUI renders with an explicit **Repair**
action. Repair is a `POST`, revision-checked like any other mutation. An HTTP
GET must never modify a user's configuration, which is exactly what blocker 3
said.

### Missing store is not an empty store

Blocker 3's sharpest case: JSON deleted while an owned, non-empty projection
still sits in config.toml. Treating that as "empty store" would make the next
write erase the active prompt and every saved body.

Three distinct states, distinguished before anything is written:

| Store | Owned projection | Meaning | Behavior |
|---|---|---|---|
| absent | absent | never used | normal first run |
| absent | **present and non-empty** | **store lost** | refuse writes, `drift: "store-missing"`, offer Repair |
| present | either | normal | normal |

Repair from `store-missing` reconstructs a single custom layer from the projected
text, presented to the user for confirmation before it is saved. The text is
still in config.toml; it is recoverable, and it is not discarded silently.

### Cross-process locking

Blocker 4 was right that an in-process mutex protects only browser tabs behind
one service. A CLI invocation, a second service, or Codex itself can all write
the same file.

`$CODEX_HOME/opencodex-prompt.lock` is an advisory lock created with `wx`,
carrying pid and start time. A lock whose pid is gone is stale and may be broken
after 10 seconds. Every opencodex writer — service, CLI, route — takes it.

That covers opencodex against itself. **It does not cover Codex**, which knows
nothing about our lock. The residual window is between step 2's read and step 4's
rename. Two mitigations, and an honest limit:

- immediately before the rename, re-hash `config.toml` and compare against the
  edit base. A change aborts with `stale_revision`, nothing written. This shrinks
  the window to the rename itself.
- after the rename, re-read and confirm the file contains our two lines. If it
  does not, another writer won; report `write_superseded` rather than success.
- a race lost inside the rename cannot be prevented from user space. It is
  detected on the next read as `projection-stale`, and it is recorded in `070`
  as residual rather than claimed solved.

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

**Encoding — byte-level, no parser involved**
14. body with `"` and `\` emits exactly `\"` and `\\`, byte-compared
15. body with `"""` is unremarkable — it is three escaped quotes on one line
16. tab normalizes to four spaces; CRLF normalizes to LF
17. control characters rejected with position, nothing written
18. non-BMP Unicode and combining marks pass through unescaped
19. a 64 KiB body produces one line of the expected length
20. **after every write, the file re-read byte-for-byte contains the exact
    expected two lines** — the assertion that replaces reparse verification
21. **a golden fixture of the emitted line is checked against the TOML spec's
    basic-string grammar by hand-written matcher**, not by `Bun.TOML`

Cases 20-21 exist because `Bun.TOML.parse` on Bun 1.3.14 transposes `\t`/`\f`
and rejects `\u0007` (measured; see §Why no prompt text goes into config.toml).
A test that verified through that parser would report success on a file Codex
might read differently.

**Ownership and adoption**
22. marker + canonical line → owned, rewritten
23. marker + non-canonical line → refuse, file untouched
24. key without marker → refuse, `drift`/adopt offered, file untouched
25. adopt on a single-line basic string imports it and takes ownership
26. adopt on a multi-line or literal string is refused with path and line
27. our marker survives an unrelated boolean write

**Store, transaction, recovery**
28. custom layers round-trip through JSON
29. disabled layer stays in JSON, absent from the projection
30. all layers disabled → both generated lines removed
31. store absent + no owned projection → normal first run
32. **store absent + owned non-empty projection → `drift: "store-missing"`,
    writes refused, repair reconstructs one layer from the projected text**
33. store malformed → `store_unreadable`, config.toml untouched
34. stale revision → refused, nothing written
35. revision changes when only the marker is removed (value identical)
36. revision changes when the config is deleted
37. journal present + targets match post-image → cleaned up
38. journal present + targets differ → both rewritten from post-image
39. journal truncated + pre-image intact → both restored
40. journal truncated + pre-image damaged → `recovery_required`, nothing touched
41. config write succeeds, store write fails → config restored, request errors,
    **source of truth unchanged**
42. rollback itself fails → `recovery_required` naming both paths
43. config.toml modified between compare and rename → `stale_revision`
44. post-rename readback missing our lines → `write_superseded`
45. lock held by a live pid → second writer waits then refuses
46. lock held by a dead pid → broken after the timeout
47. **`readPromptLayers` never writes**: a read against every drift state leaves
    both files byte-identical

Cases 20, 24, 32, 41, 43, and 47 are the data-protection set. Each is driven red
once before it is trusted.

### Cross-platform

The lock uses `wx` open and pid liveness; the journal uses `fsync` + rename.
Both behave differently enough on Windows that WP1's CI must run its suite on
Linux, macOS, and Windows — the three platforms `AGENTS.md` names. Path
separators and `realpathSync.native` on a WSL-visible `$CODEX_HOME`
(`home.ts:90-107`) are covered by existing fixtures.

### No new production dependency

WP1 adds nothing to `package.json`. The audit's dependency-review blocker is
resolved by removing the dependency, not by scheduling a review: byte-level
encoding needs no TOML library, and `Bun.TOML.parse` is used only in tests, and
only where its measured defects do not apply.

## Not in this phase

No route, no GUI, no presets, no linter. WP1 ships a module and its tests.
