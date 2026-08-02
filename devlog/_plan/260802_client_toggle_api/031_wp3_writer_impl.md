# 031 — WP3 bodies: merge/remove and the writer

Paste-ready implementation for `030`. Types come from `006_module_contracts.md`
(authoritative). Sub-decade doc per LEXICO-SPLIT-01 overflow; same phase as 030.

**A-gate round-3 corrections folded in — read these before the bodies below:**

1. **A read failure is not absence.** `io.readText` returns a tagged result
   (006 §5). Only `missing` means "no file"; `failed` (EACCES/EPERM/EISDIR)
   is `unsafe` and must never reach parse/merge/write.
2. **A stale refresh removes the previous fragments first.** Apply from
   `stale` deletes the *recorded* paths, then merges the fresh contribution
   into that result. Otherwise a renamed or dropped Kimi model leaves an
   orphan the new record no longer owns, and disable can never remove it.
3. **Restore records what it actually restored**, derived from the restored
   bytes — not the fresh contribution. Recording the fresh one would let a
   later disable delete paths the restored file does not have while leaving
   the ones it does.
4. **Bookkeeping order is file → record → journal**, with compensation and a
   `residual: true` refusal when compensation itself fails (006 §5). All
   bookkeeping goes through the injected seams so the failure is testable.

The bodies in §2-§4 are written against these rules.

## 0. `src/integrations/writer-io.ts` (NEW) — the seam both reader and writer use

`loadTarget` and `defaultIntegrationIO` live here rather than in `writer.ts`
because `readIntegrationState` (021) needs them too, and a reader that
disagreed with the writer about what counts as absence would reintroduce
blocker 3 through the back door.

```ts
/** Read + classify the target, collapsing the three failure shapes correctly. */
function loadTarget(io: IntegrationIO, configPath: string):
  | { ok: true; before: string | null }
  | { ok: false; why: "not-regular-file" | "read-failed" } {
  const kind = io.statKind(configPath);
  if (kind === "missing") return { ok: true, before: null };
  if (kind !== "file") return { ok: false, why: "not-regular-file" };
  const read = io.readText(configPath);
  if (read.kind === "text") return { ok: true, before: read.text };
  // stat said "file" but the read failed: a real file we cannot see. Never
  // treat this as absence — that is how an unreadable config gets clobbered.
  if (read.kind === "failed") return { ok: false, why: "read-failed" };
  return { ok: true, before: null };   // raced deletion between stat and read
}

/**
 * Commit the client file, then the record, then the journal row — restoring
 * the file and dropping the record if either bookkeeping step fails.
 */
function commit(io: IntegrationIO, args: {
  configPath: string; before: string | null; nextText: string | null;
  record: OwnershipRecord | null; clientId: IntegrationClientId; entry: JournalEntry;
  snapshotPath?: string; state: IntegrationState;
}): WriteOutcome {
  try {
    if (args.nextText === null) io.removeFile(args.configPath);
    else { io.mkdirp(dirname(args.configPath)); io.writeText(args.configPath, args.nextText); }
  } catch (error) {
    return refuse(args.clientId, "write_failed", args.state, msg(error), args.snapshotPath);
  }
  try {
    if (args.record) io.putRecord(args.record); else io.dropRecord(args.clientId);
  } catch (error) {
    return compensate(io, args, error, "could not record ownership");
  }
  try {
    io.appendJournal(args.entry);
  } catch (error) {
    try { io.dropRecord(args.clientId); } catch { /* covered by residual below */ }
    return compensate(io, args, error, "could not append the journal row");
  }
  return { ok: true, changed: true, state: args.state, clientId: args.clientId,
           opId: args.entry.opId, message: "ok" };
}

function compensate(io: IntegrationIO, args: { configPath: string; before: string | null;
  clientId: IntegrationClientId; state: IntegrationState; snapshotPath?: string },
  cause: unknown, what: string): WriteRefused {
  try {
    if (args.before === null) io.removeFile(args.configPath);
    else io.writeText(args.configPath, args.before);
  } catch {
    // Rollback failed. Say so — a false "rolled back" is worse than the error.
    return { ok: false, reason: "write_failed", state: args.state, clientId: args.clientId,
      residual: true, snapshotPath: args.snapshotPath,
      message: `${what}, and the file could not be rolled back. It is in an intermediate state; the backup is at ${args.snapshotPath ?? "(none)"}.` };
  }
  return { ok: false, reason: "write_failed", state: args.state, clientId: args.clientId,
    snapshotPath: args.snapshotPath, message: `${what}; the change was rolled back. Cause: ${msg(cause)}` };
}
```

## 1. `src/integrations/merge.ts` (NEW)

```ts
import type { ConfigFormat, ManagedContribution, ManagedFragment } from "../clients/config-export";
import { renderToml, renderYaml, serializeDocument } from "./serialize";
import { PARSE_FAILED } from "./state";

/** Parse a client config, tolerating absence. PARSE_FAILED on garbage. */
export function parseConfig(text: string | null, format: ConfigFormat): unknown | typeof PARSE_FAILED {
  if (text === null || text.trim().length === 0) return {};
  try {
    switch (format) {
      case "json": return JSON.parse(text);
      case "json5": return Bun.JSON5.parse(text);
      case "yaml": return Bun.YAML.parse(text);
      case "toml": return Bun.TOML.parse(text);
    }
  } catch {
    return PARSE_FAILED;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Write `value` at `path`, creating intermediate objects. Returns a new document. */
export function setPath(doc: unknown, path: readonly string[], value: unknown): unknown {
  const root: Record<string, unknown> =
    typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (clone(doc) as Record<string, unknown>)
      : {};
  let cursor = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = clone(value);
  return root;
}

/** Delete `path`. Returns whether anything was removed. Prunes emptied parents we created. */
export function deletePath(doc: unknown, path: readonly string[]): { doc: unknown; removed: boolean } {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { doc, removed: false };
  const root = clone(doc) as Record<string, unknown>;
  const chain: Record<string, unknown>[] = [root];
  let cursor: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return { doc: root, removed: false };
    cursor = next as Record<string, unknown>;
    chain.push(cursor);
  }
  const leaf = path[path.length - 1]!;
  if (!(leaf in cursor)) return { doc: root, removed: false };
  delete cursor[leaf];
  // Prune containers that we emptied, but never the document root: a client
  // that legitimately has an empty `providers: {}` should keep it.
  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const node = chain[i]!;
    if (Object.keys(node).length > 0) break;
    delete chain[i - 1]![path[i - 1]!];
  }
  return { doc: root, removed: true };
}

/** Insert every fragment. Everything else in the document is preserved. */
export function mergeContribution(doc: unknown, contribution: ManagedContribution): unknown {
  let next = doc;
  for (const fragment of contribution.fragments) next = setPath(next, fragment.path, fragment.value);
  return next;
}

/**
 * Remove exactly the RECORDED paths — never a prefix scan. A user's own
 * `models["opencodex/foo"]` that we did not write has no recorded path, so it
 * survives (and the classifier reports conflict, which is the honest answer).
 */
export function removeFragments(
  doc: unknown, paths: readonly (readonly string[])[],
): { doc: unknown; removed: boolean } {
  let next = doc;
  let removed = false;
  for (const path of paths) {
    const result = deletePath(next, path);
    next = result.doc;
    removed = removed || result.removed;
  }
  return { doc: next, removed };
}

export { serializeDocument, renderToml, renderYaml };
```

## 2. `src/integrations/writer.ts` (NEW) — apply

```ts
export function applyIntegration(input: IntegrationWriteInput): WriteOutcome {
  const io = input.io ?? defaultIntegrationIO();
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  const configPath = spec.configPath(input.env);

  if (io.statKind(spec.detectDir(input.env, input.home)) !== "dir") {
    return refuse(clientId, "not_installed", "absent", `${clientId} is not installed`);
  }
  if (spec.loopbackOnly && !isLoopbackHostname(input.config.hostname)) {
    return refuse(clientId, "non_loopback", "absent",
      `${clientId} reads credentials only from its config file, so a non-loopback bind would write your key to disk. Configure it manually instead.`);
  }

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return refuse(clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read`
        : `${configPath} is not a regular file`);
  }
  const before = target.before;

  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return refuse(clientId, "unsafe", "unsafe", `${configPath} could not be parsed`);
  }

  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = readRecords()[clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution,
  });
  if (state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it`
        : `${configPath} already contains an opencodex block we did not write`);
  }
  if (state === "current") {
    return { ok: true, changed: false, state, clientId, message: "already applied" };
  }

  // A stale refresh must first drop the fragments the PREVIOUS record owned.
  // Merging alone would strand a renamed/removed model (e.g. a Kimi selector
  // that left the catalog) as an orphan the new record no longer owns, so a
  // later disable could never remove it.
  const base = state === "stale" && record
    ? removeFragments(parsed, record.fragmentPaths).doc
    : parsed;
  const merged = mergeContribution(base, contribution);
  const text = serializeDocument(merged, exportSpec.format);
  const opId = newOpId();

  // Compare-before-commit: re-read immediately before writing. A mismatch
  // means someone wrote between classify and now — abort rather than lose it.
  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while applying`);
  }

  const snapshot = captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  return commit(io, {
    configPath, before, nextText: text, clientId, state: "current",
    snapshotPath: snapshotAbsPath(snapshot),
    record: {
      clientId, configPath, fileFingerprint: fingerprint(text),
      blockFingerprint: fingerprint(canonicalContribution(contribution)),
      fragmentPaths: fragmentPathsOf(contribution), appliedAt: at, opId,
    },
    entry: { opId, clientId, kind: state === "stale" ? "refresh" : "apply", at, configPath,
             snapshot, resultFingerprint: fingerprint(text), resultAbsent: false },
  });
}
```

## 3. disable

```ts
export function disableIntegration(input: IntegrationWriteInput): WriteOutcome {
  const io = input.io ?? defaultIntegrationIO();
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  const configPath = spec.configPath(input.env);

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return refuse(clientId, "unsafe", "unsafe",
      target.why === "read-failed"
        ? `${configPath} exists but could not be read`
        : `${configPath} is not a regular file`);
  }
  const before = target.before;
  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return refuse(clientId, "unsafe", "unsafe", `${configPath} could not be parsed`);
  }

  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = readRecords()[clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution,
  });
  if (state === "absent") {
    return { ok: true, changed: false, state, clientId, message: "not applied" };
  }
  if (state === "conflict") {
    return refuse(clientId, "conflict", "conflict",
      reason === "foreign-edit"
        ? `${configPath} changed after opencodex wrote it; disable would discard that edit`
        : `${configPath} contains an opencodex block we did not write`);
  }
  // current | stale only — the file fingerprint still matches our record, so
  // the recorded paths are exactly what we put there.
  const { doc, removed } = removeFragments(parsed, record!.fragmentPaths);
  if (!removed) {
    return { ok: true, changed: false, state: "absent", clientId, message: "nothing to remove" };
  }
  const text = serializeDocument(doc, exportSpec.format);

  const recheck = io.readText(configPath);
  const rechecked = recheck.kind === "text" ? recheck.text : recheck.kind === "missing" ? null : undefined;
  if (rechecked === undefined || rechecked !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while disabling`);
  }

  const opId = newOpId();
  const snapshot = captureSnapshot(clientId, opId, before);
  const at = new Date(io.now()).toISOString();
  // record: null drops it — a record with no block would later read as conflict.
  return commit(io, {
    configPath, before, nextText: text, clientId, state: "absent", record: null,
    snapshotPath: snapshotAbsPath(snapshot),
    entry: { opId, clientId, kind: "disable", at, configPath, snapshot,
             resultFingerprint: fingerprint(text), resultAbsent: false },
  });
}
```

## 4. restore

```ts
export function restoreIntegration(input: IntegrationRestoreInput): WriteOutcome {
  const io = input.io ?? defaultIntegrationIO();
  const entry = findOperation(input.opId);
  if (!entry) throw new Error(`unknown operation ${input.opId}`);   // route maps to 404
  if (entry.clientId !== input.clientId) throw new Error("client mismatch");

  const spec = INTEGRATION_CLIENTS[entry.clientId];
  const configPath = spec.configPath(input.env);
  const snapshot = readSnapshot(entry);
  if (snapshot.kind === "expired") {
    return refuse(entry.clientId, "snapshot_expired", "absent", "that backup has expired");
  }

  const current = io.readText(configPath);
  const kind = io.statKind(configPath);
  if (current !== null && kind !== "file") {
    return refuse(entry.clientId, "unsafe", "unsafe",
      `${configPath} is not a regular file; the backup is at ${snapshot.kind === "stored" ? snapshot.path : "(none)"}`,
      snapshot.kind === "stored" ? snapshot.path : undefined);
  }

  // Drift: the file changed after the operation we are undoing.
  const drifted = fingerprint(current ?? "") !== entry.resultFingerprint;
  if (drifted && !input.confirmDrift) {
    return refuse(entry.clientId, "drift_requires_confirm", "conflict",
      "this file changed after that operation; confirm to replace it (the current version is backed up first)");
  }

  // Restore is itself journaled and itself undoable: snapshot the CURRENT file
  // first, so a confirmed drift-restore never destroys the newer edits.
  const opId = newOpId();
  const preSnapshot = captureSnapshot(entry.clientId, opId, current);
  try {
    if (snapshot.kind === "none") {
      io.removeFile(configPath);              // restore-to-absence
    } else {
      io.mkdirp(dirname(configPath));
      io.writeText(configPath, snapshot.text);
    }
  } catch (error) {
    return refuse(entry.clientId, "write_failed", "conflict", String(error), snapshotAbsPath(preSnapshot));
  }

  const restoredText = snapshot.kind === "none" ? null : snapshot.text;
  const exportSpec = EXPORT_CLIENTS[entry.clientId];
  const restoredDoc = parseConfig(restoredText, exportSpec.format);
  const fresh = exportSpec.buildContribution(exportContextOf(input));

  // The record must describe what was RESTORED, not what we would write now.
  // A snapshot taken under an older catalog/port owns different fragment
  // values — and for Kimi, a different SET of model paths. Recording the fresh
  // contribution would let a later disable delete paths the file does not have
  // while orphaning the ones it does (A-gate round 3, blocker 5).
  const actual = extractContribution(restoredDoc, entry.clientId, fresh);
  const state: IntegrationState =
    actual.fragments.length === 0
      ? "absent"
      : fingerprint(canonicalContribution(actual)) === fingerprint(canonicalContribution(fresh))
        ? "current"
        : "stale";

  const at = new Date(io.now()).toISOString();
  return commit(io, {
    configPath, before: current, nextText: restoredText, clientId: entry.clientId, state,
    snapshotPath: snapshotAbsPath(preSnapshot),
    record: state === "absent" ? null : {
      clientId: entry.clientId, configPath,
      fileFingerprint: restoredText === null ? "" : fingerprint(restoredText),
      blockFingerprint: fingerprint(canonicalContribution(actual)),
      fragmentPaths: fragmentPathsOf(actual),
      appliedAt: at, opId,
    },
    entry: { opId, clientId: entry.clientId, kind: "restore", at, configPath,
             snapshot: preSnapshot,
             resultFingerprint: restoredText === null ? "" : fingerprint(restoredText),
             resultAbsent: restoredText === null },
  });
}

/**
 * Read back the fragments actually present in a document, using the fresh
 * contribution only as the shape guide (which paths this client can own) —
 * never as the values.
 *
 * Kimi is why this cannot be a simple path lookup: its model fragments are
 * one per selector, so a restored file may own a different set than we would
 * write today. We therefore enumerate the client's owning containers and take
 * every key that carries our provider id.
 */
export function extractContribution(
  doc: unknown, clientId: IntegrationClientId, shape: ManagedContribution,
): ManagedContribution {
  const containers = new Map<string, readonly string[]>();
  for (const fragment of shape.fragments) {
    containers.set(fragment.path.slice(0, -1).join("\u0000"), fragment.path.slice(0, -1));
  }
  const fragments: ManagedFragment[] = [];
  for (const container of containers.values()) {
    const node = readPath(doc, container);
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === OPENCODE_PROVIDER_ID || key.startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
        fragments.push({ path: [...container, key], value });
      }
    }
  }
  return { clientId, fragments };
}
```

`extractContribution` is deliberately the ONLY place a prefix is consulted,
and only to read. Removal still uses recorded paths exclusively (§1), so a
user's own `opencodex/...` entry can be *observed* here — it makes the state
`conflict` at the next classify because no record covers it — but never
deleted.

## 5. Default IO seam

```ts
export function defaultIntegrationIO(): IntegrationIO {
  return {
    readText: p => {
      try { return { kind: "text", text: readFileSync(p, "utf8") }; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ONLY ENOENT is absence. EACCES/EPERM/EISDIR mean a file we cannot
        // see, which must never be overwritten as if it were missing.
        return code === "ENOENT" ? { kind: "missing" } : { kind: "failed", ...(code ? { code } : {}) };
      }
    },
    statKind: p => { try { const s = statSync(p); return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other"; } catch { return "missing"; } },
    writeText: (p, t) => atomicWriteFile(p, t),
    removeFile: p => rmSync(p, { force: true }),
    mkdirp: p => mkdirSync(p, { recursive: true, mode: 0o700 }),
    now: () => Date.now(),
    appendJournal: entry => appendOperation(entry),
    putRecord: record => writeRecord(record),
    dropRecord: clientId => deleteRecord(clientId),
  };
}
```

Every test substitutes this wholesale — no `node:fs` monkey-patching, and the
`now` seam is what makes WP4's stale-flight branch reachable.

## 6. Activation table (superset of 030 §5)

| Branch | Trigger | Observable proof |
|---|---|---|
| `not_installed` | `statKind(detectDir)` returns `missing` | `reason === "not_installed"`, no journal row |
| `non_loopback` | kimi + `hostname: "0.0.0.0"` | refused; file untouched |
| `unsafe` not-regular | config path is a directory | `reason === "unsafe"` |
| `unsafe` unparseable | config contains `{{{` | `reason === "unsafe"` |
| conflict foreign-edit | record present, file appended to | refused; user bytes intact |
| conflict unowned-key | fragments present, no record | refused |
| idempotent apply | apply twice | second `changed === false`, no new journal row |
| compare-before-commit | `readText` returns A then B | refused `conflict`; snapshot dir gains nothing |
| `write_failed` | `writeText` throws | `reason === "write_failed"`, `snapshotPath` set |
| compensating rollback (record) | `putRecord` throws | file restored to `before`; refusal returned; no record persisted |
| compensating rollback (journal) | `appendJournal` throws | file restored to `before`; the record just written is dropped; **no phantom row** |
| residual failure | `appendJournal` throws AND the rollback `writeText` also throws | `residual === true`, message names the snapshot path, no false "rolled back" claim |
| unreadable existing file | `statKind` = `file`, `readText` returns `{kind:"failed",code:"EACCES"}` | `reason === "unsafe"`; file bytes unchanged; no snapshot captured |
| stale refresh drops orphans | apply kimi with models A+B, then re-apply after B leaves the catalog | B's `models["opencodex/B"]` is gone; an unrelated user `models["opencodex/x"]` written by hand survives |
| restore records actual ownership | restore a snapshot taken under an older catalog | the new record's `fragmentPaths` match the restored file, and the next classify is `stale` (not `conflict`, not a false `current`) |
| disable `absent` | disable a clean config | `ok`, `changed === false` |
| disable removes only ours | seed a foreign `opencodex/x` model entry | it survives; our recorded paths are gone |
| restore-to-absence | apply onto a missing file, restore that op | file no longer exists; `resultAbsent === true` |
| `snapshot_expired` | 11 ops, restore the oldest | refused `snapshot_expired` |
| `drift_requires_confirm` | apply, edit, restore without confirm | refused; with confirm succeeds and the edit is in the newest snapshot |
| restore reclassifies | restore a file containing our block | subsequent classify is `current`, not `conflict` |

## 7. Tests

`tests/integrations-writer.test.ts` — one test per row above, plus the four
cross-cutting checks from 030 §6 (no secret on disk, unrelated content
survives, round-trip parse per format, undo end-to-end byte equality). All use
`mkdtempSync` + `rmSync` and a fake `IntegrationIO` where the row calls for it.
