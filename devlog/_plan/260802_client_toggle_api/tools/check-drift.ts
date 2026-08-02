/**
 * Cross-document contract drift checker.
 *
 * `check-blocks.ts` compiles each fenced block in isolation, which catches
 * syntax and same-block type errors but is blind by construction to the defect
 * that actually kept recurring: a canonical declaration in `006` and a
 * consumer in another document disagreeing. Isolated compilation cannot see
 * that, and suppressing whole diagnostic codes to silence `noResolve` noise
 * threw away the very errors that would have shown it.
 *
 * This pass is deliberately not a type checker. It compares DECLARED SHAPES
 * across documents by text: the canonical declaration of a named type wins,
 * and any other declaration of the same name must match it field-for-field.
 * It also enforces the module-ownership rules that no compiler can infer from
 * markdown, and scans `diff` fences, which the block checker skips entirely.
 *
 * Usage: bun devlog/_plan/260802_client_toggle_api/tools/check-drift.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface Finding { file: string; line: number; rule: string; detail: string }

/** Types whose canonical declaration lives in 006 and may not be redeclared differently. */
const CANONICAL_DOC = "006_module_contracts.md";
const CANONICAL_TYPES = [
  "JournalEntry", "SnapshotRef", "OwnershipRecord", "WriteRefused", "WriteOk",
  "IntegrationIO", "IntegrationWriteInput", "IntegrationRestoreInput",
  "IntegrationJournalRow", "ManagedContribution", "ManagedFragment",
];

/**
 * Module ownership: a symbol may be DECLARED in exactly one module. Encoded
 * because `006 §8` states it in prose and prose does not fail a build.
 */
const OWNERSHIP: Record<string, string> = {
  parseConfig: "config-io.ts",
  loadTarget: "config-io.ts",
  defaultIntegrationIO: "config-io.ts",
};

/**
 * Cross-phase fields that must appear in every layer's copy of a shape.
 * A field the backend produces and the GUI never declares is a contract that
 * exists only in prose, which is how `retentionDegraded` nearly shipped as an
 * invention task for two later phases.
 */
const PROPAGATED: { field: string; shape: string; docs: string[] }[] = [
  { field: "retentionDegraded", shape: "IntegrationStatus",
    docs: ["020_wp2_ownership_core.md", "021_wp2_journal_impl.md", "060_wp6_gui_surfaces.md"] },
  { field: "snapshotCount", shape: "IntegrationStatus",
    docs: ["020_wp2_ownership_core.md", "021_wp2_journal_impl.md", "060_wp6_gui_surfaces.md"] },
  { field: "priorRecord", shape: "JournalEntry",
    docs: ["006_module_contracts.md", "020_wp2_ownership_core.md", "021_wp2_journal_impl.md"] },
];

function docs(dir: string): string[] {
  return readdirSync(dir).filter(n => /^\d{3}.*\.md$/.test(n)).sort();
}

/** Collect `export interface X { ... }` bodies, keyed by name, with location. */
function interfaceBodies(text: string, file: string): Map<string, { body: string; line: number }[]> {
  const found = new Map<string, { body: string; line: number }[]>();
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const match = /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)\s*(?:extends\s+[A-Za-z0-9_]+\s*)?\{/.exec(line);
    if (!match) continue;
    let depth = 0;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const current = lines[j]!;
      depth += (current.match(/\{/g) ?? []).length - (current.match(/\}/g) ?? []).length;
      if (j > i) body.push(current);
      if (depth <= 0 && j > i) break;
    }
    const list = found.get(match[1]!) ?? [];
    list.push({ body: body.join("\n"), line: i + 1 });
    found.set(match[1]!, list);
  }
  return found;
}

/** Field names declared in an interface body, ignoring comments and optionality. */
function fieldNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    const match = /^([A-Za-z0-9_]+)\??\s*:/.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

function main(): void {
  const unitDir = dirname(dirname(import.meta.path));
  const files = docs(unitDir);
  const findings: Finding[] = [];

  // 1. Canonical shapes.
  const canonical = interfaceBodies(readFileSync(join(unitDir, CANONICAL_DOC), "utf8"), CANONICAL_DOC);
  for (const file of files) {
    if (file === CANONICAL_DOC) continue;
    const here = interfaceBodies(readFileSync(join(unitDir, file), "utf8"), file);
    for (const name of CANONICAL_TYPES) {
      const truth = canonical.get(name)?.[0];
      const copies = here.get(name);
      if (!truth || !copies) continue;
      const expected = fieldNames(truth.body);
      for (const copy of copies) {
        const actual = fieldNames(copy.body);
        const missing = [...expected].filter(f => !actual.has(f));
        const extra = [...actual].filter(f => !expected.has(f));
        if (missing.length || extra.length) {
          findings.push({
            file, line: copy.line, rule: "canonical-shape",
            detail: `${name} disagrees with ${CANONICAL_DOC}` +
              (missing.length ? ` — missing: ${missing.join(", ")}` : "") +
              (extra.length ? ` — unexpected: ${extra.join(", ")}` : ""),
          });
        }
      }
    }
  }

  // 2. Module ownership: one declaration site, and imports point at the owner.
  for (const file of files) {
    const text = readFileSync(join(unitDir, file), "utf8");
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      for (const [symbol, owner] of Object.entries(OWNERSHIP)) {
        const declares = new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s+${symbol}\\b`).test(line);
        const ownerDoc = /021_wp2/.test(file);
        if (declares && !ownerDoc) {
          findings.push({ file, line: i + 1, rule: "ownership",
            detail: `${symbol} is declared here but is owned by ${owner} (WP2)` });
        }
        const importMatch = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`).exec(line);
        if (importMatch && !importMatch[1]!.endsWith("config-io")) {
          findings.push({ file, line: i + 1, rule: "ownership",
            detail: `${symbol} imported from ${importMatch[1]} but is owned by ${owner}` });
        }
      }
    }
  }

  // 3. Reason-first HTTP mapping (006 §5): no branch may test `state` first.
  for (const { field, shape, docs: required } of PROPAGATED) {
    for (const file of required) {
      const bodies = interfaceBodies(readFileSync(join(unitDir, file), "utf8"), file).get(shape);
      if (!bodies || bodies.length === 0) {
        findings.push({ file, line: 1, rule: "propagation",
          detail: `${shape} is not declared here, but ${field} must propagate through it` });
        continue;
      }
      if (!bodies.some(b => fieldNames(b.body).has(field))) {
        findings.push({ file, line: bodies[0]!.line, rule: "propagation",
          detail: `${shape} is missing ${field} — the contract exists in 006 but not in this layer` });
      }
    }
  }

  for (const file of files) {
    const lines = readFileSync(join(unitDir, file), "utf8").split("\n");
    let inFailureMapper = false;
    for (const [i, line] of lines.entries()) {
      if (/function\s+writerFailureResponse/.test(line)) inFailureMapper = true;
      else if (inFailureMapper && /^}/.test(line)) inFailureMapper = false;
      if (inFailureMapper && /if\s*\(\s*result\.state\s*===/.test(line)) {
        findings.push({ file, line: i + 1, rule: "reason-first",
          detail: "failure mapping branches on result.state; 006 §5 requires routing by result.reason" });
      }
    }
  }

  /*
   * 4. Diff fences. `check-blocks.ts` only reads ```ts fences, so the unit's
   * 18 diff hunks — a required part of DIFFLEVEL's before/after form — were
   * entirely unverified. Reconstruct the added side of each hunk (context
   * lines plus `+` lines, with `-` lines dropped) and check it for
   * placeholders and for balance, which is as far as a patch fragment can be
   * checked without its surrounding file.
   */
  for (const file of files) {
    const lines = readFileSync(join(unitDir, file), "utf8").split("\n");
    let hunk: { start: number; added: string[] } | null = null;
    for (const [i, line] of lines.entries()) {
      if (/^```diff\s*$/.test(line)) { hunk = { start: i + 1, added: [] }; continue; }
      if (hunk && /^```\s*$/.test(line)) {
        const text = hunk.added.join("\n");
        if (/\/\*\s*(…|\.\.\.)/.test(text)) {
          findings.push({ file, line: hunk.start, rule: "diff-placeholder",
            detail: "the added side of this hunk carries a placeholder body" });
        }
        /*
         * Bracket balance is NOT checked: a hunk legitimately shows the middle
         * of a file, so imbalance is the normal case, not a defect. Checking it
         * produced five false positives on correct patches. What IS checkable
         * without the surrounding file: a placeholder body (above), and an
         * added line that still carries a diff marker, which means the patch
         * was pasted into itself.
         */
        for (const [offset, added] of hunk.added.entries()) {
          if (/^\s*[+-]{1}[A-Za-z_{("']/.test(added)) {
            findings.push({ file, line: hunk.start + offset, rule: "diff-nested-marker",
              detail: "an added line still carries a diff marker" });
          }
        }
        hunk = null;
        continue;
      }
      if (hunk) {
        if (/^-/.test(line)) continue;           // removed: not part of the result
        hunk.added.push(/^\+/.test(line) ? line.slice(1) : line);
      }
    }
  }

  if (findings.length === 0) {
    console.log(`drift: clean across ${files.length} docs.`);
    return;
  }
  console.log(`drift: ${findings.length} finding(s)\n`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.rule}] ${f.detail}`);
  process.exitCode = 1;
}

if (import.meta.main) main();
