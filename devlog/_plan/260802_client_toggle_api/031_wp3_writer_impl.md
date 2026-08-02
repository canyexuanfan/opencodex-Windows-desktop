# 031 — WP3 bodies: merge/remove and the writer

Paste-ready implementation for `030`. Types come from `006_module_contracts.md`
(authoritative). Sub-decade doc per LEXICO-SPLIT-01 overflow; same phase as 030.

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
  const spec = INTEGRATION_CLIENTS[input.clientId];
  const exportSpec = EXPORT_CLIENTS[input.clientId];
  const configPath = spec.configPath(input.env);
  const clientId = input.clientId;

  if (io.statKind(spec.detectDir(input.env, input.home)) !== "dir") {
    return refuse(clientId, "not_installed", "absent", `${clientId} is not installed`);
  }
  if (spec.loopbackOnly && !isLoopbackHostname(input.config.hostname)) {
    return refuse(clientId, "non_loopback", "absent",
      `${clientId} reads credentials only from its config file, so a non-loopback bind would write your key to disk. Configure it manually instead.`);
  }

  const before = io.readText(configPath);
  const kind = io.statKind(configPath);
  if (before !== null && kind !== "file") {
    return refuse(clientId, "unsafe", "unsafe", `${configPath} is not a regular file`);
  }
  const parsed = parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return refuse(clientId, "unsafe", "unsafe", `${configPath} could not be parsed`);
  }

  const contribution = exportSpec.buildContribution(exportContextOf(input));
  const record = readRecords()[clientId] ?? null;
  const { state, reason } = classifyIntegration({
    fileText: before, fileIsRegular: before === null || kind === "file",
    parsed, record, contribution,
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

  const merged = mergeContribution(parsed, contribution);
  const text = serializeDocument(merged, exportSpec.format);
  const opId = newOpId();

  // Compare-before-commit: re-read immediately before writing. A mismatch means
  // someone wrote between our classify and now — abort rather than lose it.
  if (io.readText(configPath) !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while applying`);
  }

  const snapshot = captureSnapshot(clientId, opId, before);
  try {
    io.mkdirp(dirname(configPath));
    io.writeText(configPath, text);
  } catch (error) {
    return refuse(clientId, "write_failed", state,
      error instanceof Error ? error.message : String(error),
      snapshotAbsPath(snapshot));
  }

  // Compensating: if bookkeeping fails after the config write, put the file
  // back. A half-applied state with no journal row would be unrecoverable.
  try {
    appendOperation({
      opId, clientId, kind: "apply", at: new Date(io.now()).toISOString(), configPath,
      snapshot, resultFingerprint: fingerprint(text), resultAbsent: false,
    });
    writeRecord({
      clientId, configPath, fileFingerprint: fingerprint(text),
      blockFingerprint: fingerprint(canonicalContribution(contribution)),
      fragmentPaths: fragmentPathsOf(contribution),
      appliedAt: new Date(io.now()).toISOString(), opId,
    });
  } catch (error) {
    rollbackTo(io, configPath, before);
    return refuse(clientId, "write_failed", state,
      `applied but could not record it; the change was rolled back: ${String(error)}`,
      snapshotAbsPath(snapshot));
  }

  return { ok: true, changed: true, state: "current", clientId, opId, message: "applied" };
}

function rollbackTo(io: IntegrationIO, path: string, before: string | null): void {
  try { before === null ? io.removeFile(path) : io.writeText(path, before); } catch { /* best effort */ }
}
```

## 3. disable

```ts
export function disableIntegration(input: IntegrationWriteInput): WriteOutcome {
  /* identical preflight through classify */
  if (state === "absent") {
    return { ok: true, changed: false, state, clientId, message: "not applied" };
  }
  if (state === "conflict" || state === "unsafe") {
    return refuse(clientId, state === "unsafe" ? "unsafe" : "conflict", state, /* … */);
  }
  // current | stale only — i.e. the file fingerprint still matches our record.
  const { doc, removed } = removeFragments(parsed, record!.fragmentPaths);
  if (!removed) {
    return { ok: true, changed: false, state: "absent", clientId, message: "nothing to remove" };
  }
  const text = serializeDocument(doc, exportSpec.format);
  if (io.readText(configPath) !== before) {
    return refuse(clientId, "conflict", "conflict", `${configPath} changed while disabling`);
  }
  const opId = newOpId();
  const snapshot = captureSnapshot(clientId, opId, before);
  try { io.writeText(configPath, text); }
  catch (error) { return refuse(clientId, "write_failed", state, String(error), snapshotAbsPath(snapshot)); }
  try {
    appendOperation({ opId, clientId, kind: "disable", at: nowIso(io), configPath, snapshot,
      resultFingerprint: fingerprint(text), resultAbsent: false });
    deleteRecord(clientId);   // a record with no block would later read as conflict
  } catch (error) {
    rollbackTo(io, configPath, before);
    return refuse(clientId, "write_failed", state, `disabled but could not record it; rolled back: ${String(error)}`, snapshotAbsPath(snapshot));
  }
  return { ok: true, changed: true, state: "absent", clientId, opId, message: "disabled" };
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
  appendOperation({
    opId, clientId: entry.clientId, kind: "restore", at: nowIso(io), configPath,
    snapshot: preSnapshot,
    resultFingerprint: restoredText === null ? "" : fingerprint(restoredText),
    resultAbsent: restoredText === null,
  });

  // Reclassify the restored content so the caller knows what it produced —
  // this is why restore needs models/config/port (006 §5).
  const contribution = EXPORT_CLIENTS[entry.clientId].buildContribution(exportContextOf(input));
  const parsed = parseConfig(restoredText, EXPORT_CLIENTS[entry.clientId].format);
  const { state } = classifyIntegration({
    fileText: restoredText, fileIsRegular: true, parsed, record: null, contribution,
  });
  if (state === "absent") deleteRecord(entry.clientId);
  else writeRecord({
    clientId: entry.clientId, configPath,
    fileFingerprint: restoredText === null ? "" : fingerprint(restoredText),
    blockFingerprint: fingerprint(canonicalContribution(contribution)),
    fragmentPaths: fragmentPathsOf(contribution),
    appliedAt: nowIso(io), opId,
  });

  return { ok: true, changed: true, state, clientId: entry.clientId, opId, message: "restored" };
}
```

A restored file that still contains our fragments gets a **fresh record whose
`fileFingerprint` is of the restored bytes** — so the very next classify reads
`current`/`stale` rather than `conflict`. Without that step every restore
would leave the client permanently locked.

## 5. Default IO seam

```ts
export function defaultIntegrationIO(): IntegrationIO {
  return {
    readText: p => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    statKind: p => { try { const s = statSync(p); return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other"; } catch { return "missing"; } },
    writeText: (p, t) => atomicWriteFile(p, t),
    removeFile: p => rmSync(p, { force: true }),
    mkdirp: p => mkdirSync(p, { recursive: true, mode: 0o700 }),
    now: () => Date.now(),
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
| compensating rollback | `writeText` succeeds, journal append throws | file restored to `before`; refusal returned |
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
