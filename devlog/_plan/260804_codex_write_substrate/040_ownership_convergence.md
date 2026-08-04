# WP12 — ownership authority and convergence

Research: `004_ownership_and_convergence.md`. Read it first; this document is the
implementation diff for its Decision. Source citations and diff context below were
re-verified at `7e67a8d06311de2471b0a25e41cf85f97007cc69` on 2026-08-04.

The failure to prevent is data loss, not an untidy status result. Today a dead-PID
version-1 journal with no injected hashes is treated as permission to replay its
baseline (`src/codex/journal.ts:109-134`), while a corrupt service-state mirror is
collapsed into the same `null` as no service (`src/service.ts:165-175`) and the
native teardown preflight converts that uncertainty to success
(`src/integrations/native/ownership-preflight.ts:21-35`). If startup replaces the
separate external-provider check with that service check, it can overwrite a
`config.toml` now owned by another provider. WP9-WP11 add a gather/commit seam,
off-event-loop history work, and a bounded per-home lock. WP12 adds the authority
admission that must run before that lock can create anything, the provenance needed
to prove what OpenCodex created, and an observed-state projection that distinguishes
desired intent from actual convergence.

## IN / OUT

IN:

| Path | Change | Why |
|---|---|---|
| `src/types.ts` | MODIFY | Adds only `clientIntegrations.codex?: boolean`; absent means desired ON. |
| `src/config.ts` | MODIFY | Parses the one-key extension-safe object and exports a pure, file-backed Codex intent reader. |
| `src/service.ts` | MODIFY | Stops skipping bad service-state mirrors and exposes read-only registration/mirror evidence. |
| `src/integrations/native/ownership-preflight.ts` | MODIFY | Replaces the fail-open boolean preflight with the tri-state mutation authority. |
| `src/codex/integration-record.ts` | NEW | Owns `getConfigDir()/integrations/codex.json`, including WP10 history state and the exact provenance ledger below. |
| `src/codex/ownership-convergence.ts` | NEW | Owns read-only admission, gather/lock/recheck orchestration, observed state, and convergence results. |
| `src/codex/journal.ts` | MODIFY | Makes journal inspection read-only and typed; recovery becomes an under-lock operation over a previously inspected dead writer. |
| `src/codex/inject.ts` | MODIFY | Preserves external-provider bytes, removes filename-based deletion authority, and exposes only receipt-gated apply/restore commits. |
| `src/codex/sync.ts` | MODIFY | Delegates apply to the common convergence owner instead of gathering/writing from a startup-captured config object. |
| `src/codex/catalog/sync.ts` | MODIFY | Records catalog/cache post-images and restores baseline absence; cache invalidation is no longer an unowned write. |
| `src/server/index.ts` | MODIFY | Removes the unconditional startup cache write at current line 403. |
| `src/cli/index.ts` | MODIFY | Routes start and both ensure branches through the one admission order; proxy startup survives an ownership refusal. |
| `src/server/management/config-routes.ts` | MODIFY | Makes `/api/sync` reread persisted intent instead of passing the server-captured `config`. |
| `tests/codex-ownership-authority.test.ts` | NEW | Pins owned/foreign/unknown and the no-artifact-before-answer invariant. |
| `tests/codex-artifact-provenance.test.ts` | NEW | Pins baseline absence, matching-post-image deletion, and preserved-drift conflict behavior. |
| `tests/codex-observed-state.test.ts` | NEW | Pins the complete observed projection and desired/observed convergence relation. |
| `tests/codex-convergence-order.test.ts` | NEW | Pins the trace order for startup, ensure, sync, apply, restore, stop, and uninstall entry points. |
| `tests/codex-journal.test.ts` | MODIFY | Reverses corrupt/unknown journal deletion and markerless automatic replay expectations. |
| `tests/codex-models-cache-restore.test.ts` | NEW | Proves an apply-created cache returns to absence and native drift is preserved. |
| `tests/codex-sync-api.test.ts` | MODIFY | Proves one running server observes CLI intent changes made by another process. |
| `tests/service.test.ts`, `tests/uninstall.test.ts` | MODIFY | Pin mirror conflict/unreadable evidence and fail-closed teardown. |
| `docs-site/src/content/docs/reference/cli/lifecycle.md` | MODIFY | Documents blocked/external/partial convergence without claiming that proxy startup failed. |
| `docs-site/src/content/docs/reference/configuration.md` | MODIFY | Documents `clientIntegrations.codex`, absent-means-ON, and desired versus observed state. |

The predecessor names `src/codex/write-lock.ts` (WP11) and
`src/codex/history-convergence.ts` (WP10) are consumed but not redesigned here.
WP12 may modify their exported record composition/types only where the exact
`integrations/codex.json` schema below requires it; it must not weaken WP10's
off-event-loop boundary or WP11's acquisition protocol.

OUT: `gui/**`, Grok, Claude Code, Claude Desktop, the six file integrations,
provider transport, releases, publishing, deployment, tags, npm, and the live proxy
on port 10100. WP12 supplies state/result types for the later Codex toggle, but it
does not add that route or render a switch. It does not promise byte-exact rollback
after a user or Codex has edited a baseline-absent artifact; that case can only be
preserved and reported.

## The tri-state authority

The public API belongs at the existing native preflight boundary. It returns the
canonical homes and evidence because a boolean cannot distinguish “another home
owns this” from “the ownership record could not be read”.

```ts
/**
 * Whether this process may mutate native Codex artifacts for one canonical home.
 *
 * `owned` is positive evidence: either no service registration and no mirror
 * exist, or every readable/required mirror agrees with the installed service and
 * the current canonical homes. `foreign` is a valid claim by another home.
 * `unknown` means the evidence needed to choose is missing or cannot be trusted.
 * Callers must permit native writes only for `owned`.
 */
export type NativeCodexOwnership =
  | {
      state: "owned";
      evidence: "no-service" | "matching-install";
      codexHome: string;
      opencodexHome: string;
    }
  | {
      state: "foreign";
      codexHome: string;
      opencodexHome: string;
      recordedCodexHome: string;
      recordedOpenCodexHome: string;
      message: string;
    }
  | {
      state: "unknown";
      reason:
        | "service-state-missing"
        | "service-state-corrupt"
        | "service-state-unreadable"
        | "service-state-conflict"
        | "service-registration-unknown"
        | "path-unresolvable";
      codexHome?: string;
      opencodexHome?: string;
      message: string;
    };

/**
 * Read service registration and every known install-state mirror without repair,
 * directory creation, SQLite open, chmod, unlink, rename, or config loading.
 */
export function inspectNativeCodexOwnership(): NativeCodexOwnership;
```

`assertNativeTeardownOwned` currently fails open for every error that is not the
specific mismatch class (`src/integrations/native/ownership-preflight.ts:25-35`).
That behavior was written for an interactive teardown route where a human sees the
result and can immediately repair a stale service record. Automatic convergence is
unattended: it runs during startup, ensure, server requests, crash recovery, and
later retries. In that setting an unreadable authority record cannot be converted
to deletion permission. A false refusal leaves residue that can be inspected; a
false success can destroy a newer config, catalog, or cache. Therefore both
`foreign` and `unknown` refuse, while the proxy itself may continue serving.

### Actual diff — `src/integrations/native/ownership-preflight.ts:14-35`

```diff
 import {
-  assertServiceEnvironmentMatchesInstall,
-  isServiceOwnershipError,
+  inspectServiceInstallOwnership,
 } from "../../service";

-export type NativeTeardownOwnership = { ok: true } | { ok: false; message: string };
+export type NativeTeardownOwnership =
+  | { ok: true; ownership: Extract<NativeCodexOwnership, { state: "owned" }> }
+  | { ok: false; ownership: Exclude<NativeCodexOwnership, { state: "owned" }>; message: string };

+/**
+ * Read-only native mutation authority. Only `owned` authorizes a Codex write;
+ * foreign and unknown evidence are equally non-authorizing.
+ */
+export function inspectNativeCodexOwnership(): NativeCodexOwnership {
+  return inspectServiceInstallOwnership();
+}
+
 export function assertNativeTeardownOwned(): NativeTeardownOwnership {
-  try {
-    assertServiceEnvironmentMatchesInstall();
-    return { ok: true };
-  } catch (error) {
-    if (isServiceOwnershipError(error)) {
-      // The message names both the recorded and the current home — that is the
-      // refusal text, verbatim, because the user has to act on it.
-      return { ok: false, message: error.message };
-    }
-    // Unrelated failure (corrupt state file, IO): mirror
-    // `serviceEnvironmentOwnedHere` and fail open rather than wedging the route
-    // behind a check whose own input is broken.
-    return { ok: true };
-  }
+  const ownership = inspectNativeCodexOwnership();
+  return ownership.state === "owned"
+    ? { ok: true, ownership }
+    : { ok: false, ownership, message: ownership.message };
 }
```

The `NativeCodexOwnership` declaration is inserted above
`NativeTeardownOwnership`; it is shown in full in the API block above and is not
duplicated in the diff.

### Actual diff — `src/service.ts:165-175`

The low-level reader must retain all mirror outcomes rather than returning the
first convenient valid row. `serviceRegistration` is derived from the existing
platform registration probes used by `diagnoseService` at
`src/service.ts:2370-2416`, but returns `unknown` when the platform probe itself
cannot establish presence. It is read-only; it does not call install, repair,
start, stop, or uninstall.

```diff
-function readServiceInstallState(): ServiceInstallState | null {
-  for (const path of serviceStatePaths()) {
-    try {
-      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
-      if (parsed) return parsed;
-    } catch {
-      /* try the next known state path */
-    }
-  }
-  return null;
-}
+export type ServiceInstallStateRead =
+  | { status: "absent"; path: string }
+  | { status: "valid"; path: string; state: ServiceInstallState }
+  | { status: "corrupt"; path: string; message: string }
+  | { status: "unreadable"; path: string; message: string };
+
+/** Read every known mirror without creating, deleting, or repairing any path. */
+export function readServiceInstallStates(): readonly ServiceInstallStateRead[] {
+  return serviceStatePaths().map(path => {
+    try {
+      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
+      return parsed
+        ? { status: "valid" as const, path, state: parsed }
+        : { status: "corrupt" as const, path, message: "invalid service-state schema" };
+    } catch (error) {
+      const code = (error as NodeJS.ErrnoException).code;
+      if (code === "ENOENT") return { status: "absent" as const, path };
+      if (error instanceof SyntaxError) {
+        return { status: "corrupt" as const, path, message: error.message };
+      }
+      return { status: "unreadable" as const, path, message: error instanceof Error ? error.message : String(error) };
+    }
+  });
+}
```

Immediately after this reader, add `inspectServiceInstallOwnership()`. Its truth
table is exact:

| Registration evidence | Mirror evidence | Result |
|---|---|---|
| absent | all absent | `owned/no-service` |
| installed | all required mirrors valid, canonical pairs equal each other and current pair | `owned/matching-install` |
| any | any valid mirror names another canonical pair | `foreign` |
| installed | all absent | `unknown/service-state-missing` |
| any | corrupt | `unknown/service-state-corrupt` |
| any | unreadable | `unknown/service-state-unreadable` |
| any | two valid canonical pairs disagree | `unknown/service-state-conflict` |
| unknown | no valid decisive foreign claim | `unknown/service-registration-unknown` |
| any | current or recorded path cannot be canonicalized | `unknown/path-unresolvable` |

A valid foreign claim wins over an absent sibling mirror, but never over a corrupt,
unreadable, or conflicting mirror: those are `unknown`, because the complete evidence
set is not trustworthy. Existing `readServiceBackend`, diagnostics, and interactive
service commands may keep a compatibility helper that selects one valid state; native
mutation admission must use only the all-mirror reader.

## One admission order (C8)

Every start, ensure branch, sync, apply, restore, stop, uninstall, and retry uses one
sequence. No caller may select a subset or reorder it:

1. **Canonical paths.** Resolve existing canonical `CODEX_HOME`, `OPENCODEX_HOME`,
   effective `config.toml`, generated profile, active catalog, cache, journal,
   history DB, rollouts, integration record, and WP11 lock path without creating
   any component. Failure is `unknown/path-unresolvable`.
2. **Service ownership.** Call `inspectNativeCodexOwnership`. `foreign` or
   `unknown` returns `blocked` and stops this sequence.
3. **External provider.** Read the effective project `model_provider` from
   `config.toml` without mutation. An external provider returns `external` and
   stops every journal, config, profile, catalog, cache, history, rollout, backup,
   provenance, and lock write.
4. **Journal/liveness.** Inspect without cleanup. Invalid/unknown-version bytes,
   a live writer, or liveness `unknown` block. A valid dead writer is recoverable
   only after provenance also authorizes it.
5. **Provenance.** Read and validate `integrations/codex.json` without creating it.
   A missing record is legal only when no OpenCodex residue requiring ownership
   proof exists. Corrupt, wrong-version, conflicting transaction, missing post-image,
   or artifact/hash disagreement blocks the corresponding transition.
6. **Fresh intent.** Call `readPersistedCodexIntent`; only diagnostics with
   `source === "file"` are authoritative. Missing/unreadable/invalid config is
   `unknown`, never default ON.
7. **Gather.** For desired ON, run WP9 provider/catalog gathering outside the lock.
   It may await network I/O and must not write. Desired OFF has no gather step.
8. **Lock/recheck.** Only now call WP11 acquisition. Its construction order remains
   canonical-home validation -> authority receipt -> private namespace validation ->
   stable lock file -> SQLite open -> `BEGIN IMMEDIATE`
   (`003_lock_protocol.md:178-196`). Once acquired, repeat steps 1-6 from disk and
   compare the new authority/intent digest with the pre-lock receipt. Any change
   aborts before a native write.
9. **Commit/observe.** Recover an authorized dead journal first, then apply or
   restore using the locked candidate/ledger. Read observed state while still
   serialized. Release before logs, HTTP response shaping, network retries, or
   app-server handling.

Testable invariant:

> Until steps 1-6 have returned authoritative answers, the filesystem snapshot must
> show no new lock file, SQLite database or sidecar, directory, journal, integration
> record, catalog backup, catalog, cache, config, profile, history manifest, history
> row, or rollout line. A `foreign`, `unknown`, `external`, live-writer, or unknown-
> journal trace ends before the first `lock:*` event.

WP11's lock database is outside both configurable homes, but it is still an artifact
and is forbidden before the answer is known. Passing a path that happens to be
writable is not an authority receipt.

## External `model_provider` remains a distinct authority (C9)

Service-home ownership answers: “does another OpenCodex service installation claim
this canonical `CODEX_HOME`/`OPENCODEX_HOME` pair?” It says nothing about who owns
the contents of `config.toml`. The external-provider guard answers: “has the user
delegated effective Codex routing to a provider other than native `openai` or
`opencodex`?” A matching OpenCodex service can coexist with a newly selected
external provider; service ownership may be `owned` while config mutation authority
is absent.

The previous design deleted this guard by substituting the service-home check. That
was wrong (`008_audit_synthesis_wp4_r2.md:31-35`). The external check stays after
service ownership and before journal inspection. It vetoes apply, restore, repair,
journal deletion, catalog/cache cleanup, history changes, and rollout changes. The
result is `external`, not “already converged”.

### Actual diff — `src/codex/inject.ts:481-503,764-770`

```diff
   const activeProvider = externalCodexModelProvider(rawContent);
   if (activeProvider) {
-    // A launcher may have journaled before the provider manager took ownership. Never let shutdown
-    // replay that stale snapshot over externally managed config.
-    removeJournal();
     const nativeSubagentDefaultsWarning = configuredManagedSubagentDefaults(config)
       ? `Native Codex sub-agent defaults were not injected: external model_provider ${tomlString(activeProvider)} owns config.toml.`
       : undefined;
```

```diff
 export function restoreNativeCodex(): { success: boolean; message: string } {
   const activeProvider = currentExternalCodexModelProvider();
   if (activeProvider) {
-    removeJournal();
-    return { success: true, message: `External Codex provider ${tomlString(activeProvider)} preserved; no native restore was needed.` };
+    return {
+      success: false,
+      message: `Native Codex restore blocked: external model_provider ${tomlString(activeProvider)} owns config.toml; no Codex artifact was changed.`,
+    };
   }
```

Then make the writing body `restoreNativeCodexUnlocked(receipt)` internal to
`ownership-convergence.ts`; public callers receive the typed common convergence
result. `removeCodexConfig` may perform structural removal only with ledger entries
for the exact fragments and current transaction. Its current filename-only profile
unlink at `src/codex/inject.ts:723-742` is removed.

## Provenance ledger and absence restoration (C10)

### Location and exact record

The one owned operational record is
`getConfigDir()/integrations/codex.json`. It is outside `CODEX_HOME`; it composes
WP10 history convergence with WP12 provenance. Desired intent remains the fresh
file-backed `clientIntegrations.codex` value in the main config so there is one
intent authority. `lastAdmittedDesired` below is evidence, not a writable intent.

```ts
export interface CodexIntegrationRecordV1 {
  version: 1;
  /** Diagnostic snapshot only; never used instead of readPersistedCodexIntent(). */
  lastAdmittedDesired?: "on" | "off";
  history: Record<string, CodexHistoryConvergenceRecord>;
  provenance: {
    activeTransactionId: string | null;
    transactions: Record<string, CodexArtifactTransaction>;
  };
}

export interface CodexArtifactTransaction {
  id: string;
  desired: "on" | "off";
  state: "prepared" | "committing" | "applied" | "restoring" | "restored" | "conflict";
  startedAt: string;
  completedAt?: string;
  artifacts: Record<string, CodexArtifactLedgerRow>;
}

export type CodexArtifactKind =
  | "config"
  | "profile"
  | "catalog"
  | "catalog-backup"
  | "cache"
  | "journal"
  | "history-manifest"
  | "history-row"
  | "rollout";

export interface CodexArtifactLedgerRow {
  kind: CodexArtifactKind;
  canonicalPath: string;
  baseline:
    | { state: "absent" }
    | { state: "present"; sha256: string; bytesBase64?: string; mode?: number };
  /** Written only after the candidate write succeeds and its bytes are read back. */
  postImage: { sha256: string; recordedAt: string } | null;
  ownedStructure?: {
    routedSlugs?: string[];
    configFragments?: string[];
    historyRows?: Array<{
      threadId: string;
      modelProvider: string | null;
      source: string | null;
      rolloutPath: string | null;
    }>;
    rolloutProviders?: Array<{
      path: string;
      firstLine: string | null;
      latest: string | null;
    }>;
  };
  restore:
    | { state: "pending" }
    | { state: "restored-exact"; recordedAt: string }
    | { state: "restored-structural"; recordedAt: string }
    | { state: "preserved-drift"; recordedAt: string; currentSha256: string; message: string }
    | { state: "blocked"; recordedAt: string; message: string };
}
```

`bytesBase64` is required for byte-restorable present baselines (config, profile,
catalog, cache, and pre-existing backups). It is omitted for history DB/rollout
rows, which restore semantically from `ownedStructure`; copying SQLite or JSONL
bytes would overwrite concurrent native work. The record reader validates version,
transaction ids, canonical unique paths, SHA-256 width, base64/hash agreement, and
the single active transaction. A malformed record is `blocked/provenance-unknown`.

### When rows are written

1. After pre-lock admission passes and WP11 is acquired, re-read all baselines.
2. Before the first native artifact write, atomically persist one `prepared`
   transaction containing a row for every artifact the commit can touch. This is
   where baseline `absent` is recorded.
3. Set the transaction to `committing`; perform one candidate write.
4. After that write returns, read the resulting bytes, compute full SHA-256, and
   atomically persist `postImage`. Only then may the row prove “created by us”.
5. Repeat steps 3-4 per artifact. Set `applied` only after observed state verifies
   every required ON artifact. Partial/crashed work retains the active transaction.

A filename, marker, slash-qualified slug, mtime, backup name, or file location is
never creation proof. Creation requires both `baseline.state === "absent"` and a
non-null successful `postImage.sha256`. A crash after a native write but before the
post-image ledger update leaves `postImage:null`; that is intentionally unknown and
cannot authorize automatic deletion.

### Restoration rules

- Baseline present + current hash equals post-image: restore exact baseline bytes,
  then verify the baseline hash.
- Baseline absent + current hash equals post-image: unlink, then verify absence.
- Baseline absent + current hash differs: preservation wins. If the format is
  parseable and `ownedStructure` identifies exact OpenCodex fragments/rows, remove
  only those fragments and preserve native additions. Report operational
  `absent` with historical `preserved-drift`; never report byte-exact restoration.
- Baseline absent + drift is unparseable/ambiguous: make no write and report a
  conflict. Deleting would destroy user data; rewriting would invent a baseline.
- Missing ledger, null post-image, wrong transaction, or hash mismatch without an
  exact structural owner: preserve and block.

The hardest case is deliberate: config, catalog, or cache was absent; OpenCodex
created it; Codex or the user later added native data. OFF must not delete that
file. It removes only proven routed residue when possible and reports
`preserved-drift`; otherwise it preserves the entire file and reports `blocked`.
Historical absence cannot be restored without data loss, so the implementation
must say so.

### Actual diff — `src/codex/journal.ts:97-107,148-162`

```diff
-function readJournal(): Journal | null {
-  if (!existsSync(JOURNAL_PATH)) return null;
+export type JournalInspection =
+  | { state: "absent" }
+  | { state: "invalid"; reason: "corrupt" | "unknown-version"; message: string }
+  | { state: "valid"; journal: Journal; writer: "alive" | "dead" | "unknown"; postImageKnown: boolean };
+
+/** Inspect journal bytes and writer liveness without deleting or rewriting them. */
+export function inspectJournal(): JournalInspection {
+  if (!existsSync(JOURNAL_PATH)) return { state: "absent" };
   try {
-    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as Journal;
-    if (journal.version !== 1) throw new Error("unknown version");
-    return journal;
-  } catch {
-    removeJournal();
-    return null;
+    const value = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as Partial<Journal>;
+    if (value.version !== 1) return { state: "invalid", reason: "unknown-version", message: "unsupported journal version" };
+    const journal = value as Journal;
+    let writer: "alive" | "dead" | "unknown";
+    try { process.kill(journal.pid, 0); writer = "alive"; }
+    catch (error) {
+      const code = (error as NodeJS.ErrnoException).code;
+      writer = code === "ESRCH" ? "dead" : "unknown";
+    }
+    return {
+      state: "valid",
+      journal,
+      writer,
+      postImageKnown: typeof journal.injectedConfigHash === "string" && journal.injectedProfileHash !== undefined,
+    };
+  } catch (error) {
+    return { state: "invalid", reason: "corrupt", message: error instanceof Error ? error.message : String(error) };
   }
 }
```

```diff
-export function reconcileJournal(): boolean {
-  const journal = readJournal();
-  if (!journal) return false;
-  try {
-    process.kill(journal.pid, 0);
-    return false;
-  } catch (e: unknown) {
-    if ((e as NodeJS.ErrnoException).code === "EPERM") {
-      return false;
-    }
-  }
-  const restored = restoreJournalState();
+export function reconcileJournalUnlocked(
+  inspection: Extract<JournalInspection, { state: "valid" }>,
+): RestoreJournalResult {
+  if (inspection.writer !== "dead" || !inspection.postImageKnown) {
+    return { configRestored: false, profileRestored: false, configChanged: false, profileChanged: false, complete: false };
+  }
+  const restored = restoreJournalState(inspection.journal);
-  if (!restored.configRestored && !restored.profileRestored) return false;
-  console.error(`⚠️  Previous session (PID ${journal.pid}) did not shut down cleanly. Codex state restored from journal.`);
-  return true;
+  return restored;
 }
```

The final implementation returns `RestoreJournalResult` consistently; no log is
emitted under the lock. `restoreJournalState` accepts the inspected journal and no
longer calls a reader that could change the authority answer. Markerless version-1 journals are
valid but `postImageKnown:false`; provenance cannot prove current bytes, so
automatic recovery blocks instead of assuming unchanged.

## Observed state and `unchanged` convergence (C11)

`inspectCodexObservedState` is read-only and returns:

```ts
export type CodexObservedState =
  | { state: "applied"; historical: "exact"; artifacts: CodexArtifactObservation[] }
  | { state: "absent"; historical: "exact" | "preserved-drift"; artifacts: CodexArtifactObservation[] }
  | { state: "partial"; historical: "exact" | "preserved-drift" | "unknown"; artifacts: CodexArtifactObservation[] }
  | { state: "external"; provider: string; artifacts: CodexArtifactObservation[] }
  | { state: "blocked"; reasons: string[]; artifacts: CodexArtifactObservation[] };

export interface CodexConvergenceResult {
  desired: "on" | "off" | "unknown";
  observed: CodexObservedState;
  converged: boolean;
  changed: boolean;
  refusal?: "foreign" | "unknown" | "external" | "journal-active" | "provenance" | "lock-busy";
  message: string;
}

export interface CodexSyncConvergenceResult extends CodexConvergenceResult {
  ok: boolean;
  retryable: boolean;
  added: number;
  catalogPath: string | null;
  catalogExists: boolean;
  catalogWritten: boolean;
  cacheSynced: boolean;
}
```

The observer reads all of these before answering “is Codex currently applied?”:

1. service ownership and external provider;
2. `config.toml` root `model_provider`, owned `openai_base_url`, active
   `model_catalog_json`, embedded `[profiles.opencodex]`, routed root model, and
   managed defaults;
3. generated profile existence, bytes/hash, and provenance;
4. active catalog parse state, provenance, and every transaction-recorded routed slug;
5. `models_cache.json` in wrapper or raw-catalog shape, provenance, and routed slugs;
6. journal validity, writer liveness, transaction identity, and post-image matches;
7. history DB rows tagged `opencodex`, backup-manifest entries, and each touched
   rollout's first-line and latest provider observations;
8. catalog backup and transaction residue, especially artifacts whose baseline was absent.

Desired ON converges only with observed `applied`; desired OFF converges only with
observed `absent`. `external`, `blocked`, and `partial` never converge. Operational
absence with `historical:"preserved-drift"` is converged for routing but is not an
exact historical restore, and the response must expose both facts.

`mutatePersistedConfig` already distinguishes `unchanged` from `committed`
(`src/config.ts:1837-1839,1877-1913`). `unchanged` says only that the boolean already
matched. It never skips observation or work: desired OFF may have a routed cache row
after a crash, and desired ON may be missing a profile/catalog after explicit restore.
Both paths run admission, converge, and re-observe.

## Fresh admission in a long-lived server (C12)

Add this pure reader beside `readConfigDiagnostics` at `src/config.ts:1714-1715`:

```ts
/** Read Codex intent from persisted, schema-valid config; never use fallback defaults as authority. */
export function readPersistedCodexIntent():
  | { state: "known"; desired: "on" | "off" }
  | { state: "unknown"; reason: "missing" | "invalid" } {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source !== "file") {
    return { state: "unknown", reason: diagnostics.source === "default" ? "missing" : "invalid" };
  }
  return { state: "known", desired: diagnostics.config.clientIntegrations?.codex === false ? "off" : "on" };
}
```

`src/types.ts:533-545` gains the one-key `OcxClientIntegrationsConfig`, and
`src/config.ts:916-940` gains a `.passthrough()` nested schema. Unknown future
integration keys survive a field-scoped mutation. This substrate defines the
reader and writer, but not a GUI/toggle route.

Every Codex-mutating request performs one config file open/read, JSON parse, and
schema validation before gather, then repeats that bounded read under the WP11
lock. Cost is two O(config-file-bytes) local reads per infrequent mutation request,
zero resident watchers, and zero cross-process cache protocol. A watcher may later
reduce diagnostics latency, but it may never replace the two admission reads.

### Actual diff — `src/server/management/config-routes.ts:261-268`

```diff
   if (url.pathname === "/api/sync" && req.method === "POST") {
-    const { syncModelsToCodex } = await import("../../codex/sync");
+    const { convergeCodexToPersistedIntent } = await import("../../codex/ownership-convergence");
     const { attachStaleAppServerHint } = await import("../../codex/app-server-processes");
-    const result = await syncModelsToCodex(undefined, config, null);
+    // The server-captured `config` at handleConfigRoutes line 77 is request-routing
+    // state, not mutation authority. This call rereads disk before gather and lock.
+    const result = await convergeCodexToPersistedIntent({ source: "api-sync", log: null });
     return jsonResponse({
       ...attachStaleAppServerHint(result),
       ...(result.ok ? {} : { error: result.message }),
-    }, result.ok ? 200 : 500);
+    }, result.ok ? 200 : result.retryable ? 409 : 503);
   }
```

The API result adapter retains the existing sync fields (`added`, `catalogPath`,
`catalogExists`, `catalogWritten`, `cacheSynced`) from WP9 and adds desired,
observed, converged, refusal, and retryable. It does not read `config` to gate Codex.

### Actual diff — `src/cli/index.ts:169-177,318-321,358-369,398-412`

```diff
-import { reconcileJournal } from "../codex/journal";
+import { convergeCodexToPersistedIntent } from "../codex/ownership-convergence";
```

```diff
 async function handleStart(options: { block?: boolean } = {}) {
@@
   const requestedPort = parsePortOption();
-  if (!currentExternalCodexModelProvider()) reconcileJournal();
   const existingPid = readPid();
```

```diff
   await maybeShowStarPrompt(); // once-only Yes/No GitHub-star prompt on first interactive start
-  await syncModelsToCodex(port).catch(() => {});
+  const codex = await convergeCodexToPersistedIntent({ source: "startup", port, log: console });
+  if (!codex.converged) console.error(`⚠️  ${codex.message}`);
   if (!currentExternalCodexModelProvider() && !shouldInjectApiAuthHeader(config) && config.syncResumeHistory !== false) {
```

```diff
 async function handleEnsure() {
-  if (!currentExternalCodexModelProvider()) reconcileJournal();
   const config = loadConfig();
@@
     if (live) {
-      await syncModelsToCodex(live.port).catch(e => {
-        console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
-      });
+      const codex = await convergeCodexToPersistedIntent({ source: "ensure-live", port: live.port, log: console });
+      if (!codex.converged) console.error(`⚠️  ${codex.message}`);
```

```diff
-  await syncModelsToCodex(port).catch(e => {
-    console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
-  });
+  const codex = await convergeCodexToPersistedIntent({ source: "ensure-parent", port, log: console });
+  if (!codex.converged) console.error(`⚠️  ${codex.message}`);
```

The spawned child runs the startup path and the parent runs `ensure-parent`; both
admit independently from disk. The operation is idempotent under WP11, so the second
observer either proves convergence or performs residue repair. `src/server/index.ts`
removes import/current line 403 `invalidateCodexModelsCache()`; cache mutation occurs
only in the admitted commit. Thus the proxy can bind and serve other clients even
when Codex admission returns foreign, unknown, or external.

## Common orchestrator

`src/codex/ownership-convergence.ts` exports exactly these entry points:

```ts
export interface CodexAdmissionReceipt {
  canonicalCodexHome: string;
  canonicalOpenCodexHome: string;
  authorityDigest: string;
  desired: "on" | "off";
  journalTransactionId: string | null;
  provenanceRevision: string;
}

/** Steps 1-6 only. This function performs no write and opens no coordinator. */
export function inspectCodexMutationAdmission():
  | { status: "admitted"; receipt: CodexAdmissionReceipt }
  | { status: "blocked" | "external"; result: CodexConvergenceResult };

/** Run the fixed admission -> gather -> lock/recheck -> commit/observe sequence. */
export async function convergeCodexToPersistedIntent(options: {
  source: "startup" | "ensure-live" | "ensure-parent" | "api-sync" | "explicit" | "teardown";
  port?: number;
  log?: Pick<Console, "log" | "error"> | null;
}): Promise<CodexSyncConvergenceResult>;

/** Read the complete artifact projection without repair. */
export function inspectCodexObservedState(): CodexObservedState;
```

The under-lock recheck computes a new receipt and requires equality of canonical
homes, authority digest, desired intent, journal transaction, and provenance
revision. WP9 candidate revisions are checked separately before catalog commit.
No caller can supply `desired` or ownership as an option; test seams replace the
readers, not the verdict.

## Test plan

All tests use fresh temporary `CODEX_HOME`, `OPENCODEX_HOME`, real-user-home lock
namespace overrides supplied by WP11's test seam, and port `0`. None invokes
`ocx start`, `ocx stop`, `ocx sync`, `ocx restore`, or `ocx ensure`, and none reaches
the live listener on 10100.

### Authority and ordering

1. `tests/codex-ownership-authority.test.ts` — no service/no mirrors is owned;
   matching mirrors are owned; foreign canonical pair is foreign; installed plus
   missing mirror, corrupt mirror, unreadable mirror, conflicting valid mirrors,
   registration unknown, and unresolvable paths are unknown.
2. **Dead-PID markerless journal plus external provider, byte-exact preservation.**
   Seed version-1 journal without injected hashes and dead PID, external
   `model_provider`, config, profile, catalog, both backup forms, cache, history
   manifest, SQLite DB, and rollout sentinels. Run startup admission and ensure
   admission independently. Hash all bytes before/after; assert identical bytes,
   journal present, no mtime change where supported, result `external`, and no lock,
   SQLite, provenance, journal, or native artifact created.
3. Foreign-home run asserting **NO artifact was created**. Snapshot both homes and
   the WP11 namespace; call startup, ensure, API sync, and teardown entries. Assert
   the trace ends at `service:foreign`, directory trees and hashes are identical,
   and lock DB/sidecars, integration record, journal, catalog backup, and cache are absent.
4. Invalid and unknown-version journals remain byte-exact and return blocked.
   `EPERM`/liveness-unknown is not treated as dead.
5. Ordered trace table for every entry point:
   `paths -> service -> external -> journal -> provenance -> intent -> gather ->
   lock -> paths -> service -> external -> journal -> provenance -> intent ->
   recover -> commit -> observe`. Desired OFF omits only `gather`; every refusal
   ends before `lock`.

### Provenance and restoration

1. Apply into absent config/profile/catalog/backups/cache/journal/history-manifest;
   assert each row first records `baseline:absent`, then a read-back post-image hash.
2. Restore with unchanged post-images; assert every transaction-created artifact
   returns to absence and the transaction reaches `restored`.
3. **Cache absence restoration.** Begin without `models_cache.json`, apply routed
   data, prove ledger absence + successful cache post-image, then desired OFF must
   unlink it. A second OFF is a no-write success. This is different from the current
   creation-only assertion at `tests/codex-models-cache-invalidate.test.ts:41-55`.
4. Baseline absent followed by native edits for config, catalog, and cache. Add
   native content after apply. OFF preserves native additions, removes only exact
   ledger-owned routing, and reports operational absent plus historical
   `preserved-drift`. Unparseable drift is fully preserved and returns blocked.
5. Crash after artifact write but before post-image ledger write; restart sees
   `postImage:null`, preserves the artifact, and reports provenance conflict.
6. Pre-existing same-named profile/catalog/cache/backup with no matching ledger is
   never unlinked. Present-baseline exact restore requires current hash == post-image.
7. History/rollout restoration stays semantic: originals remain in the manifest
   until DB rows and both first-line/latest rollout observations agree.

### Observed state and fresh intent

1. Table-drive applied, absent, each one-artifact partial, external, blocked, and
   preserved-drift historical status. Include stale first-line rollout metadata and
   a non-empty manifest with no matching DB row.
2. Persist desired OFF first, seed one residue artifact at a time, perform an
   `unchanged` OFF write, and prove every case still converges.
3. Persist desired ON first, remove config/profile/catalog/cache one at a time,
   perform an `unchanged` ON write, and prove reconstruction plus re-observation.
4. **Running server honors another process.** Construct the server with stale ON
   in memory, persist OFF from a subprocess, call `/api/sync`, and assert no gather
   or native write. Persist ON from the subprocess, call the same running server,
   and assert gather/apply occurs without restart. Repeat with invalid persisted
   config and assert unknown/no write.

## Verification

Fresh implementation gates:

```bash
bun run typecheck
bun test tests/codex-ownership-authority.test.ts
bun test tests/codex-artifact-provenance.test.ts tests/codex-models-cache-restore.test.ts
bun test tests/codex-observed-state.test.ts tests/codex-convergence-order.test.ts
bun test tests/codex-journal.test.ts tests/codex-sync-api.test.ts tests/service.test.ts tests/uninstall.test.ts
bun run test
bun run lint:gui
bun run privacy:scan
```

Live proof is the real in-process server/subprocess case in
`tests/codex-sync-api.test.ts`, bound to port `0` with isolated homes. Its evidence
must show one server PID, two separate config-writer PIDs, OFF causing zero gather
and zero native writes, then ON causing the ordered gather/lock/commit path without
server restart. Artifact proof is the post-test tree/hash receipt from the external,
foreign, cache-absence, and preserved-drift fixtures. A green response envelope or
green suite without those read-backs is insufficient. Do not use the live proxy on
10100 for WP12 verification.

## Accept criteria

- **C8 — authority before artifacts.** Foreign and unknown service ownership fail
  closed. Tests prove no lock file/database/sidecar, directory, journal, provenance
  record, or native artifact is created before paths, service ownership, external
  provider, journal/liveness, provenance, and fresh intent all answer.
- **C9 — separate external authority.** A matching service does not override an
  external effective `model_provider`; apply, restore, repair, journal cleanup,
  catalog/cache/history/rollout writes all remain byte-exactly suppressed.
- **C10 — creation and preservation.** “Created by us” requires ledger baseline
  absence plus successful read-back post-image hash. Matching post-images restore
  absence. Later native edits are preserved and reported as conflict or
  `preserved-drift`; no byte-exact claim is made where none is possible.
- **C11 — observed convergence.** Config, profile, catalog, cache, journal, history,
  rollouts, backups, and provenance are inspected. `unchanged` intent still runs
  convergence and post-observation; only ON/applied and OFF/absent are converged.
- **C12 — fresh server admission.** Every Codex mutation rereads file-backed intent
  before gather and under lock. The subprocess test proves a CLI OFF and later ON
  are honored by the same running server at a cost of two O(config-file-bytes)
  local reads per mutation request.

## Explicitly open after `004`

The Decision leaves two future hardening items, neither of which may be silently
claimed here: journal liveness still identifies a writer by PID only, so PID reuse
can conservatively delay recovery until a later journal version records a process-
start/instance token; and terminal provenance transaction retention/compaction needs
a bounded policy after enough production evidence exists. Neither gap permits fail-
open mutation. Unknown liveness or provenance remains blocked, and preservation wins.
