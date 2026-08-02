/**
 * Additive merge and surgical removal of the fragments opencodex owns.
 *
 * The rule that shapes this file: we insert exactly the paths our builder
 * named, and we delete exactly the paths a record says we wrote. Nothing here
 * ever scans for a prefix — a user's own `opencodex/...` entry is not ours to
 * remove, and inferring ownership from a name is how a config editor destroys
 * work it did not create.
 *
 * Design of record: devlog/_plan/260802_client_toggle_api/031_wp3_writer_impl.md.
 */
import type { ManagedContribution } from "../clients/config-export";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structured clone via JSON: our documents are plain data by construction. */
function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Write `value` at `path`, creating intermediate objects. Returns a new document. */
export function setPath(doc: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) throw new Error("setPath needs a non-empty path");
  const root: Record<string, unknown> = isPlainRecord(doc) ? clone(doc) : {};
  let cursor = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainRecord(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = clone(value);
  return root;
}

/**
 * Delete `path`. Prunes containers this deletion emptied, but never the
 * document root: a client that legitimately keeps an empty `providers: {}`
 * should still have it afterwards.
 */
export function deletePath(doc: unknown, path: readonly string[]): { doc: unknown; removed: boolean } {
  if (!isPlainRecord(doc) || path.length === 0) return { doc, removed: false };
  const root = clone(doc) as Record<string, unknown>;
  const chain: Record<string, unknown>[] = [root];
  let cursor: Record<string, unknown> = root;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainRecord(next)) return { doc: root, removed: false };
    cursor = next;
    chain.push(cursor);
  }
  const leaf = path[path.length - 1]!;
  if (!(leaf in cursor)) return { doc: root, removed: false };
  delete cursor[leaf];
  // Parent containers are NOT pruned. We own the leaf we recorded, not the map
  // that holds it: a user who wrote `providers: {}` before we existed still has
  // it afterwards. Removing a now-empty parent looked tidy and quietly deleted
  // a line the user had written.
  return { doc: root, removed: true };
}

/** Insert every fragment. Everything else in the document is preserved. */
export function mergeContribution(doc: unknown, contribution: ManagedContribution): unknown {
  let next = doc;
  for (const fragment of contribution.fragments) next = setPath(next, fragment.path, fragment.value);
  return next;
}

/**
 * Remove exactly the RECORDED paths — never a prefix scan. An entry that
 * matches our naming but has no recorded path is not ours: it reads as
 * `conflict` and survives untouched.
 */
export function removeFragments(
  doc: unknown,
  paths: readonly (readonly string[])[],
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
