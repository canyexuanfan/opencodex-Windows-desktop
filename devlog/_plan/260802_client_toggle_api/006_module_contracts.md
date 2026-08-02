# 006 — Canonical module contracts (single source of truth)

A-gate amendment (round 1, blockers 3/4/5/6/8). The decade docs were written
in parallel and drifted on type names, discriminants, and signatures. This
document is now the ONLY place shared types are defined; every decade doc
references it and may not redeclare them. Where a decade doc disagrees with
this file, this file wins.

## 1. Serialization (WP1) — corrected

**Verified 2026-08-02 on Bun 1.3.14:**
`Bun.YAML.stringify({a:1,b:{c:"d"}})` returns `"{a: 1,b: {c: d}}"` — **flow
style, no trailing newline**. It is valid YAML, but it is not what a user
expects to find in their `config.yaml`, and it breaks the "exactly one
trailing newline" contract 010 claimed.

Decision: **hand-render YAML too**, the same way TOML is hand-rendered. Both
documents we emit are shallow (a provider map plus a model list), so a narrow
block-style renderer is ~40 lines and fully testable, and it gives us stable
bytes we control.

```ts
/** Block-style YAML for the shallow shapes we emit. Throws on anything else. */
export function renderYaml(value: unknown, indent = 0): string;

/** Every serializer returns text ending in exactly one "\n". */
export function serializeDocument(document: unknown, format: ConfigFormat): string;
```

Accept criterion (010 §5, amended): for all four formats and all six clients,
`text.endsWith("\n") && !text.endsWith("\n\n")`, and each text round-trips
through its format's parser to a deep-equal document.

## 2. Managed contribution — the fix for "one provider key" (blocker 3)

A client's generated document is NOT a single provider block, and Kimi owns
**two** regions (`providers.opencodex` plus every `models["opencodex/..."]`
entry). The ownership unit is therefore a *set of fragments*, not one key.

```ts
/** One owned fragment: a JSON path plus the value we put there. */
export interface ManagedFragment {
  /** Path from the document root, e.g. ["providers","opencodex"]. */
  path: readonly string[];
  value: unknown;
}

/**
 * Everything opencodex contributes to one client's config. Produced by the
 * WP1 builder (which knows the client's schema), consumed by merge/remove and
 * fingerprinted as a unit.
 */
export interface ManagedContribution {
  /**
   * WP1's own id type. `IntegrationClientId` is a WP2 alias OF this type, not
   * a separate one — WP1 must typecheck before WP2 exists, so the dependency
   * only ever points backwards (A-gate round 2, blocker 3).
   */
  clientId: ExportClientId;
  fragments: readonly ManagedFragment[];
}

/** WP1 gains this per client; it replaces the "ownership.path" idea in 020. */
export type BuildContribution = (ctx: ExportContext) => ManagedContribution;
```

**Module ownership of shared types (blocker 3).** These live in
`src/clients/config-export.ts` (WP1), because WP1 is the earliest phase that
needs them: `ConfigFormat`, `ManagedFragment`, `ManagedContribution`,
`BuildContribution`. WP2's `src/integrations/registry.ts` re-exports
`export type IntegrationClientId = ExportClientId;` as a readability alias.
No WP1 file imports from `src/integrations/`.

**Canonical model loader (blocker 4).** Both the existing
`/api/client-config` route and the new integration routes need the same
"visible, non-disabled catalog rows as `ExportModel[]`" list. Today
`listManagementModelRows` and `toExportModel` are private to
`src/server/management/model-routes.ts`. WP1 extracts them:

```ts
// src/server/management/model-rows.ts  (NEW, WP1 scope)
export async function listManagementModelRows(config: OcxConfig): Promise<ManagementModelRow[]>;
export function toExportModel(row: ManagementModelRow): ExportModel;
/** Visible (non-disabled) rows as export models — the one loader both routes use. */
export async function loadExportModels(config: OcxConfig): Promise<ExportModel[]>;
```

`model-routes.ts` imports from it instead of declaring them; WP4's file scope
gains this import change. No behavior change to `/api/client-config` — the
extraction is mechanical and its existing test pins the envelope.

Per-client fragments:

| Client | fragments |
|---|---|
| opencode | `["provider","opencodex"]` |
| pi / hermes / gajae | `["providers","opencodex"]` |
| openclaw | `["models","providers","opencodex"]` |
| kimi | `["providers","opencodex"]` **and one `["models","opencodex/<selector>"]` per model** |

Removal removes **exactly the recorded fragment paths** — never a prefix
scan. The record stores the paths, so a user's own `models["opencodex/foo"]`
written before we existed is not ours and is not deleted (it reads as
`conflict`, per 003 §3 "our key with no ownership record").

`buildClientConfig` (the existing whole-document builder) stays for the
read-only export surface. `buildContribution` is the new writer-side
function. They share the same per-client model normalization.

## 3. Snapshot state — absent vs expired (blocker 6)

`null` was overloaded: "the file did not exist" and "the snapshot was
collected" are different facts and only one of them is recoverable.

```ts
export type SnapshotRef =
  | { kind: "none" }                    // the file did not exist before this op
  | { kind: "stored"; relPath: string } // snapshot bytes on disk
  | { kind: "expired" };                // row survives, bytes were GC'd

export interface JournalEntry {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore";
  at: string;
  configPath: string;
  snapshot: SnapshotRef;
  /** Fingerprint of the file AFTER this op. "" when the op left no file. */
  resultFingerprint: string;
  /** True when the op's result was file absence — restore means "delete". */
  resultAbsent: boolean;
}
```

`readSnapshot(opId)` returns `{ kind: "none" } | { kind: "stored"; text } |
{ kind: "expired" }`. Restore semantics follow the tag:

- `none` → restore means **remove the file we created**, allowed only when the
  current file is still ours by fingerprint. This is the "restore a fresh
  apply back to absence" case the audit found unrepresentable.
- `stored` → write those bytes back (with the §5 preflight).
- `expired` → refuse `snapshot-expired`.

**Ordering fix:** GC runs **after** the journal row is committed, never during
capture, so a crash between capture and append can never orphan the newest
snapshot.

**Secret handling:** snapshot bytes may contain a user's own credentials (we
copy their file verbatim). They are written with `atomicWriteFile`, which
applies `0600` plus Windows ACL hardening — the same protection opencodex
gives its own credential store. This is no longer an open question.

## 4. Writer result — one union, one spelling (blocker 4)

```ts
export type RefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export interface WriteOk {
  ok: true;
  changed: boolean;
  state: IntegrationState;
  clientId: IntegrationClientId;
  /** Present when the operation was journaled (changed === true). */
  opId?: string;
  message: string;
}

export interface WriteRefused {
  ok: false;
  /** ONE field name across every layer. 030's `refused` is retired. */
  reason: RefusalReason;
  state: IntegrationState;
  clientId: IntegrationClientId;
  message: string;
  /** Absolute path of a recoverable snapshot, when one exists. */
  snapshotPath?: string;
}

export type WriteOutcome = WriteOk | WriteRefused;
```

Discriminant literals are **snake_case everywhere** (they travel to JSON), so
040's `drift_requires_confirm` is canonical and 030's `drift-needs-confirm`
is retired. `snapshotPath` is part of the union, so 040 must forward it and
060's manual-recovery Notice is reachable.

## 5. Exact writer/state signatures (blocker 4)

`ManagementContext` does not carry models or port, so the writer takes its own
explicit input rather than being handed a route context:

```ts
export interface IntegrationWriteInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam: read/write/now. Defaults to real fs + Date.now. */
  io?: IntegrationIO;
}

export interface IntegrationIO {
  readText: (path: string) => string | null;
  statKind: (path: string) => "file" | "dir" | "other" | "missing";
  writeText: (path: string, text: string) => void;   // defaults to atomicWriteFile
  removeFile: (path: string) => void;
  mkdirp: (path: string) => void;
  now: () => number;
}

export function readIntegrationState(input: Omit<IntegrationWriteInput, "io"> & { io?: IntegrationIO }): IntegrationStatus;
export function applyIntegration(input: IntegrationWriteInput): WriteOutcome;
export function disableIntegration(input: IntegrationWriteInput): WriteOutcome;
/**
 * Restore takes the SAME input as apply/disable plus the operation to undo.
 * It needs `models`/`config`/`port` because after writing the snapshot back it
 * must rebuild the fresh contribution to classify the result as current vs
 * stale — a restore that cannot say which state it produced is a rollback the
 * UI has to guess about (A-gate round 2, blocker 4).
 */
export interface IntegrationRestoreInput extends IntegrationWriteInput {
  opId: string;
  confirmDrift?: boolean;
}
export function restoreIntegration(input: IntegrationRestoreInput): WriteOutcome;
```

`clientId` on a restore input must equal the journal row's `clientId`; a
mismatch is a programming error and throws rather than writing the wrong
client's file.

`IntegrationIO` is the seam blocker 7 requires: compare-before-commit is
tested by a `readText` that returns different bytes on the second call, and
`write_failed` by a `writeText` that throws — no monkey-patching of `node:fs`.
`now` makes the single-flight stale-replacement branch reachable in a test.

The route layer builds `IntegrationWriteInput` from `ManagementContext` plus
the catalog rows it already fetches for `/api/client-config` — 040 §route
handlers are amended to do exactly that.

## 6. Journal row over the wire (blocker 5)

ONE name, used by 040 and 060 identically:

```ts
export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore";
  at: string;
  configPath: string;
  /** Derived per request: "none" | "stored" | "expired". */
  snapshot: SnapshotRef["kind"];
  /** Derived per request; see 040. `undoEligible` in 060 is retired. */
  undoable: boolean;
}
```

040's pasted handler must actually build this (the audit found it returning
raw operations), and 060 consumes `snapshot === "expired"` for the
`백업 만료됨` row and `undoable` for the undo affordance.

## 7. Phase-boundary corrections (blocker 2)

- **WP2 verifies without WP3.** Its tests construct config files and
  `OwnershipRecord` fixtures **directly on disk** (write a file, write a
  record, classify). No activation scenario may say "apply, then …" — apply
  does not exist yet. The 020 activation table is rewritten accordingly.
- **WP5 and WP6 merge into one work-phase (WP5).** The audit is right that a
  shell with no surfaces cannot compile-and-verify on its own. The merged
  phase closes with the GUI building, `lint:gui` clean, and its routing +
  surface tests green. The goalplan's `workPhases[]` is amended: seven phases,
  not eight.

## 8. Diff-level completeness (blocker 1)

Every decade doc carries: each file with NEW/MODIFY, real signatures (no
`ctx: {...}`), complete bodies for new modules, before/after context for
modifications, and exact test filenames. **No gap is deferred to a later P.**
The round-1 wording that scheduled the remaining bodies as per-phase work is
retired — DIFFLEVEL-ROADMAP-01 requires the roadmap to be executable *before*
A, and "fill it in per cycle" is exactly what that rule forbids.

Named gaps and where they are now closed:

| Gap | Closed in |
|---|---|
| Hermes/OpenClaw/Kimi/Gajae builder + contribution bodies | `011_wp1_builders.md` |
| Journal + ownership implementation bodies | `021_wp2_journal_impl.md` |
| Writer bodies (apply/disable/restore, merge/remove) | `031_wp3_writer_impl.md` |
| Journal route handler + row derivation | `040` §journal (rewritten in place) |
| WP6 principal components | `061_wp6_components.md` |
| docs-site + test filenames | `070` scope list (already concrete) |

Sub-decade docs (`011`, `021`, `031`, `061`) are the standard overflow form
(LEXICO-SPLIT-01): they carry the long paste-ready bodies so the decade doc
stays the readable design, and they are part of the same phase.
