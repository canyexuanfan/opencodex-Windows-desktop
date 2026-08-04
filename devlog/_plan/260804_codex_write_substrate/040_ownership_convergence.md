# WP12 — ownership authority and convergence

Research: `004_ownership_and_convergence.md`. Shared contract:
`005_contract.md`.

The failure to prevent is data loss, not an untidy status result. Today a dead-PID
version-1 journal without injected hashes can replay its baseline
(`src/codex/journal.ts:109-162`), corrupt service-state mirrors collapse toward the
same absence result used for no service (`src/service.ts:165-175`), and native
teardown fails open for errors outside its one mismatch class
(`src/integrations/native/ownership-preflight.ts:21-35`). A matching service-home
check also does not authorize overwriting a `config.toml` whose effective
`model_provider` is now external.

WP9-WP11 already provide the working `convergeCodex` funnel, catalog split,
history protocol, generations, integration-record owner, and native lock. WP12
completes the mechanisms behind that funnel: tri-state service authority,
file-backed intent, journal/provenance admission, restoration, and observed-state
inspection. It does **not** add another record module, another convergence module,
another route mapping, or another public result union.

The prior plan named `write-lock.ts`, created `ownership-convergence.ts`, redefined
`integrations/codex.json`, and exported `convergeCodexToPersistedIntent`. Those are
deleted. Contract names are exact: `codex-write-lock.ts`, `integration-record.ts`,
and `convergence.ts` (`005_contract.md` §8).

WP12 is independently landable: it modifies the existing working funnel and
contract implementations in one commit, rewires every remaining lifecycle caller
in that commit, and typechecks/preserves behavior without a future phase. WP13 may
re-prove composition; it is not required to make WP12 correct.

All current-code citations and diff context below were rechecked on 2026-08-04 at
`2d5e080dea3e7000bf2111b381c7c1a3c4f5fb11`.

## IN / OUT

IN:

| Path | Change | Why |
|---|---|---|
| `src/types.ts` | MODIFY | Add `clientIntegrations.codex?: boolean`; absent means desired ON. |
| `src/config.ts` | MODIFY | Parse the extension-safe object; own config generation bumps and authoritative `AdmissionSnapshot` reads. |
| `src/service.ts` | MODIFY | Preserve all service registration/mirror evidence instead of skipping corrupt/unreadable rows. |
| `src/integrations/native/ownership-preflight.ts` | MODIFY | Tri-state read-only service-home authority; only owned permits native mutation. |
| `src/codex/convergence.ts` | MODIFY | Complete admission, provenance, restore, observation, and lifecycle routing behind the contract entry point. |
| `src/codex/convergence-types.ts` | IMPORT ONLY | Consume `AdmissionSnapshot`, `CodexObservedState`, `ConvergeOutcome`, `CodexProvenanceLedger`, and section types; no WP12 union. |
| `src/codex/integration-record.ts` | USE/MODIFY THROUGH OWNER API | Read/update provenance and native transition through the contract owner; no path/schema/parser here. |
| `src/codex/codex-write-lock.ts` | CONSUME | Correct WP11 module name; no lock redesign. |
| `src/codex/journal.ts` | MODIFY | Read-only typed inspection; authorized recovery only inside convergence. |
| `src/codex/inject.ts` | MODIFY | Receipt-gated internal apply/restore mechanics; remove filename-based deletion authority. |
| `src/codex/sync.ts` | MODIFY | Remove the remaining alternate native orchestration; delegate to `convergeCodex`. |
| `src/codex/catalog/sync.ts` | MODIFY | Report post-images and perform provenance-authorized restoration behind convergence. |
| `src/server/index.ts` | MODIFY | Remove unconditional cache invalidation at current line 403. |
| `src/cli/index.ts`, `src/service.ts` | MODIFY | Route startup, ensure, explicit restore/eject, stop, uninstall, and recovery through `convergeCodex`. |
| `src/server/management/config-routes.ts` | MODIFY | Call `convergeCodex` and the contract response adapter only. |
| `tests/codex-ownership-authority.test.ts`, `tests/codex-artifact-provenance.test.ts`, `tests/codex-observed-state.test.ts`, `tests/codex-convergence-order.test.ts`, `tests/codex-models-cache-restore.test.ts` | NEW | Authority, provenance, observation, ordering, and current-byte drift. |
| `tests/codex-journal.test.ts`, `tests/codex-sync-api.test.ts`, `tests/service.test.ts`, `tests/uninstall.test.ts`, `tests/codex-convergence-contract.test.ts` | MODIFY | Recovery, fresh intent, fail-closed service behavior, and production funnel. |
| `docs-site/src/content/docs/reference/cli/lifecycle.md`, `docs-site/src/content/docs/reference/configuration.md` | MODIFY | Refusal/recovery and persisted intent; link route behavior to the contract adapter. |

OUT:

- `src/codex/ownership-convergence.ts` — deleted from the plan. There is one entry
  module, `src/codex/convergence.ts`.
- Ownership of `src/codex/integration-record.ts`, its path/schema/validators, or
  `/api/sync` mapping — `005_contract.md` §§1, 5.
- A module named `src/codex/write-lock.ts`; the consumer import is
  `src/codex/codex-write-lock.ts`.
- New request/result/observed-state/provenance section unions. All shared shapes
  come from `convergence-types.ts`.
- GUI, Grok, Claude Code/Desktop, six file integrations, provider transport,
  release/publish/deploy actions, and the live proxy on 10100.
- The Pi required-nonempty file-client incident. The third baseline class is
  removed and remains `FOLLOWUP-FILECLIENT-01` (`005_contract.md` §9).

## Tri-state service-home authority

The service preflight owns evidence collection, not the shared convergence result.
Its implementation may use a private/local discriminated union so it can explain
why an `AdmissionSnapshot.ownership` is `owned | foreign | unknown`; it must not
export a second convergence outcome.

Truth table:

| Registration evidence | Mirror evidence | Admission ownership |
|---|---|---|
| absent | all absent | `owned` |
| installed | all required mirrors valid and canonical pairs match current | `owned` |
| any | decisive valid mirror names another pair | `foreign` |
| installed | all absent | `unknown` |
| any | corrupt, unreadable, conflicting mirrors | `unknown` |
| unknown | no decisive valid foreign claim | `unknown` |
| any | any required path cannot be canonicalized | `unknown` |

Corrupt/unreadable/conflicting evidence wins over a convenient absent sibling. A
false refusal leaves inspectable residue; a false success can destroy newer user
state. Only `owned` reaches a native write.

`src/service.ts:165-175` becomes an all-mirror read that distinguishes absent,
valid, corrupt, and unreadable. Registration probes remain read-only and return
unknown when the platform cannot establish presence. Existing diagnostics may keep
a compatibility “first valid state” view; mutation admission may not use it.

```diff
-export function assertNativeTeardownOwned(): { ok: boolean; message?: string } {
-  try { assertServiceEnvironmentMatchesInstall(); return { ok: true }; }
-  catch (error) {
-    if (isServiceOwnershipError(error)) return { ok: false, message: error.message };
-    return { ok: true };
-  }
-}
+export function inspectNativeCodexOwnership(): NativeCodexOwnershipEvidence {
+  return inspectAllServiceRegistrationAndMirrors();
+}
```

`NativeCodexOwnershipEvidence` is phase-internal evidence projected to
`AdmissionSnapshot.ownership`; it is not a public shared result family.

## One admission order — exact `AdmissionSnapshot`

Every startup, ensure branch, management mutation, explicit sync/restore/eject,
stop, uninstall, retry, and observe uses this sequence. No caller selects a subset:

1. Resolve existing canonical `CODEX_HOME`, `OPENCODEX_HOME`, config/profile,
   catalog/cache, journal, history, rollouts, and integration-record targets without
   creating anything.
2. Read all service registration/mirror evidence. Foreign/unknown refuses.
3. Read effective project `model_provider`. External refuses separately.
4. Inspect journal/liveness without cleanup. Invalid/unknown-version, live writer,
   or unknown liveness refuses.
5. Read/validate the contract integration record without creating it. Missing is
   legal only when no residue needs provenance proof; corrupt/lost/conflicting
   provenance refuses.
6. Authoritatively read persisted config, config generation, intent, and ownership;
   return one exact `AdmissionSnapshot`:

```ts
const admission: AdmissionSnapshot = {
  config: diagnostics.config,
  configDigest,
  intent,
  generation: configGeneration.value,
  ownership,
};
```

7. If intent is ON, WP9 gather receives `admission.config` — **that exact object**.
   OFF does not gather.
8. Call WP11 with `admitted: admission`. Under native->config coordination,
   authoritatively re-read steps 1-6 into a second `AdmissionSnapshot` and compare
   digest, generation, intent, ownership, canonical targets, journal identity, and
   provenance identity.
9. Recover an authorized dead journal, establish baselines, commit apply/remove,
   write the expected native generation/`txId`, and inspect observed state inside
   the coordinated section. Release before logging/HTTP shaping.
10. Run WP10 history afterward under its sibling lock with the same
    `CommitExpectation` and authority snapshot identity; stale jobs are rejected.

Testable invariant:

> Before steps 1-6 return an authorizing `AdmissionSnapshot`, there is no new lock
> namespace/database/sidecar, integration record, journal, catalog backup, catalog,
> cache, config, profile, history manifest/row, or rollout line.

### Prevention and detection are different claims

For cooperating writers, stale commit is **prevented**: the config coordinator is
held through authoritative re-read and synchronous native commit. This is available
because `withConfigMutationLockSync` is synchronous (`src/config.ts:1767-1818`) and
`mutatePersistedConfig` already reruns against fresh snapshots
(`src/config.ts:1853-1913`).

For non-cooperating writers, portable conditional rename is unavailable
(`src/config.ts:1853-1859`). Bounded post-commit generation/target/current-byte
checks **detect** interference and return `deferred`; they do not retroactively
claim prevention. Regather/retry ends at `deadlineMs`, after which unresolved work
is named. This distinction is the correction required by audit #5 and
`005_contract.md` §3.

## External `model_provider` is a separate veto — C9

Service-home ownership answers who claims this OpenCodex installation. It does not
answer who owns effective `config.toml` routing. A matching service can coexist
with a newly selected external provider; that provider blocks apply, restore,
journal recovery/deletion, catalog/cache/history/rollout mutation, provenance
adoption, and lock creation.

Remove journal deletion from the external branch:

```diff
 const activeProvider = externalCodexModelProvider(rawContent);
 if (activeProvider) {
-  removeJournal();
   return externalAuthorityRefusal(activeProvider);
 }
```

External is projected through the contract's `refused` authority/result. It is not
“already converged.”

## Contract-owned provenance record

Delete the former `CodexIntegrationRecordV1`, transaction, artifact, ledger-row,
and restore unions. Import the section types:

```ts
import type {
  CodexProvenanceEntry,
  CodexProvenanceLedger,
} from "./convergence-types";
import {
  readIntegrationRecord,
  updateIntegrationRecord,
} from "./integration-record";
```

WP12 writes only `record.provenance` through `updateIntegrationRecord`; history,
generation, unknown top-level keys, and unknown section keys survive. Unparseable
or wrong-version record fails closed. No WP12 code joins
`getConfigDir()/integrations/codex.json`, validates the top-level schema, or runs a
parallel read/merge/write (`005_contract.md` §1).

## When provenance entries are written

1. After pre-lock admission and authoritative under-lock re-read, read every
   artifact baseline.
2. Before the first native write, persist contract `CodexProvenanceEntry` rows for
   every artifact this transition may touch, with this `txId` and one of the two
   contract baselines.
3. Commit one artifact.
4. Read current bytes after the successful write and persist its `postImage` hash.
5. Repeat; then write the expected native generation/`txId` and observe.

A filename, marker, slug, mtime, backup name, or location is not creation proof. A
crash after native write but before `postImage` leaves unknown provenance and cannot
authorize automatic deletion.

## Two baseline classes, no third

Consume exactly `005_contract.md` §9:

- `absent` — no baseline artifact existed;
- `present` — the contract representation carries the exact baseline needed for
  restoration plus its hash.

There is no `present-required-nonempty`. The Pi `models.json {}` incident belongs
to `FOLLOWUP-FILECLIENT-01`; a Codex artifact phase has no file-client schema or
validator with which to implement that class.

Restoration:

- present + current bytes match our post-image -> restore exact contract baseline,
  then verify baseline hash;
- absent + current bytes match our post-image -> unlink, then verify absence;
- current bytes differ -> preserve; remove only exact provenance-owned structure
  when the format and ledger make that operation unambiguous, then report
  operational absence with historical drift;
- unparseable/ambiguous drift, missing/null post-image, wrong transaction, or lost/
  corrupt ledger -> write nothing and refuse on provenance.

### C10 is current-byte drift, not historical no-edit proof

A SHA-256 comparison proves only that the bytes observed **now** equal the recorded
post-image. It cannot prove the artifact was never edited and reverted between
observations. C10 is therefore narrowed to current-byte drift detection and safe
restoration from current evidence. No test or documentation may claim detection of
an edit-and-revert ABA that leaves identical bytes.

## Lost/corrupt ledger operator recovery — carried #10

Automatic convergence always refuses lost/corrupt provenance and preserves native
bytes. “Start a fresh record” is not recovery; it silently turns unknown artifacts
into owned artifacts.

**INFERRED operator-recovery UX:** provide one explicit operator-only adoption flow
in the existing CLI, separate from normal convergence:

```text
ocx restore --adopt-current-codex-baseline
```

The flag is rejected in service/agent-driven/automatic contexts and requires an
interactive confirmation naming the canonical Codex home and that current bytes
will become the baseline. It performs read-only service/external/journal checks
first, requires the proxy stopped and no live journal writer, asks the
`integration-record.ts` owner to atomically move an unreadable record to a
timestamped sibling quarantine (preserving its bytes), then uses
`updateIntegrationRecord` against the now-absent canonical path to create a
valid record whose `present` baselines are the exact current bytes. A lost record
has no quarantine source but follows the same exact-current-baseline validation. It
changes no Codex native artifact.

If even one target is unreadable/ambiguous, adoption aborts before replacing the
record. A subsequent explicit `convergeCodex` performs the requested apply/remove
from the adopted baseline. The command prints the quarantine path and resulting
`txId`; automatic callers receive only the provenance refusal and operator
instruction. Tests never auto-confirm this action.

This is a recovery path, not a second convergence entry point: adoption establishes
authority evidence; all native mutation still goes through `convergeCodex`.

## Journal inspection and recovery

`src/codex/journal.ts` gains a read-only inspection result local to the journal
module. Corrupt/unknown-version bytes are preserved. PID `EPERM`/unknown is not
dead. A markerless version-1 journal may be structurally valid but lacks post-image
proof and blocks automatic replay.

```diff
-export function reconcileJournal(): boolean {
-  const journal = readJournal();
-  // read may delete malformed journal; dead PID may replay automatically
-}
+export function inspectJournal(): JournalInspection {
+  // Read/validate/liveness only; no delete, rename, repair, or replay.
+}
+
+function reconcileJournalUnlocked(
+  inspection: AuthorizedDeadJournal,
+): RestoreJournalResult {
+  // Called only by convergence inside the coordinated commit.
+}
```

No log is emitted while locks are held.

## Observed state consumes contract types — C11

Delete `CodexObservedState`, `CodexConvergenceResult`, and
`CodexSyncConvergenceResult` from this document. `inspectCodexObservedState`
returns the contract's `CodexObservedState`; `convergeCodex` returns the contract's
`ConvergeOutcome`.

The observer reads service/external authority, managed config fragments, profile,
catalog/cache and routed slugs, journal/liveness, provenance/generation/tx identity,
history DB/manifest/rollouts, backups, and partial transaction residue. It performs
no repair.

Desired ON converges only when the contract observer says applied. Desired OFF
converges only when residue is removed/restored. External/refused/partial remains
non-converged. Current-byte structural preservation can be operationally removed
while still reporting historical drift; it cannot be described as byte-exact
restoration.

`mutatePersistedConfig` already distinguishes `unchanged` from `committed`
(`src/config.ts:1837-1839,1877-1913`). `unchanged` intent never skips observation or
work: OFF may retain crash residue; ON may be missing a profile/catalog after an
explicit restore.

## Fresh admission in a long-lived server — C12

The old “one config read” cost claim is withdrawn. WP9 gather uses the exact config
object from the first `AdmissionSnapshot`, but `005_contract.md` §§3-4 requires an
authoritative re-read inside the coordinated commit. These are compatible duties,
not one read:

1. full persisted read before gather -> `AdmissionSnapshot A`; gather uses
   `A.config`;
2. full authoritative persisted re-read under native->config coordination ->
   `AdmissionSnapshot B`; compare B to A before commit;
3. cheap expected-transition checks around/after commit.

No resident watcher or server-captured config is authority. The config reader
returns unknown for missing/unreadable/invalid persisted config; default fallback
ON is not sufficient to mutate.

```diff
+function readCodexAdmissionSnapshot():
+  | AdmissionSnapshot
+  | Extract<ConvergeOutcome, { kind: "refused" | "failed" }> {
+  const diagnostics = readConfigDiagnostics();
+  if (diagnostics.source !== "file") return contractAdmissionRefusal(diagnostics.source);
+  return admittedSnapshotFromPersistedConfig(diagnostics);
+}
```

The helper is module-private and returns only contract shapes; it does not publish
an `AdmissionSnapshotResult` union.

`src/types.ts` adds the one-key client-integrations object; the config schema is
passthrough so unknown future integration keys survive a scoped mutation.

## `/api/sync` calls the contract adapter only

Delete WP12's status logic and custom result adapter. Current route
`src/server/management/config-routes.ts:261-268` becomes:

```diff
 if (url.pathname === "/api/sync" && req.method === "POST") {
-  const result = await syncModelsToCodex(undefined, config, null);
-  return jsonResponse(result, result.ok ? 200 : 500);
+  const outcome = await convergeCodex({
+    action: "converge",
+    reason: "api-sync",
+    mode: "explicit",
+    deadlineMs: EXPLICIT_CODEX_CONVERGENCE_DEADLINE_MS,
+  });
+  return toSyncResponse(outcome);
 }
```

Status, body, and `Retry-After` belong only to
`src/server/management/sync-response.ts` (`005_contract.md` §5).

## One common entry point

`src/codex/convergence.ts` exports the contract's `convergeCodex` and no
`convergeCodexToPersistedIntent`, `inspectCodexMutationAdmission` public receipt,
or WP12-specific request/result type.

```ts
export async function convergeCodex(
  request: ConvergeRequest,
): Promise<ConvergeOutcome>;
```

Callers say when/reason/mode/deadline. They never supply desired state, ownership,
journal verdict, provenance verdict, or apply/remove direction. `action:"observe"`
is the one read-only public operation; internal admission/observer helpers stay
module-private unless another contract phase explicitly owns them.

Rewire remaining startup/ensure/restore/eject/stop/uninstall paths in the same WP12
commit. Current direct sites include startup/ensure sync
(`src/cli/index.ts:319,367,409`), explicit restore/sync
(`src/cli/index.ts:528,591,756,768,829`), service restore
(`src/service.ts:2587,2625`), and server stop restore
(`src/server/management-api.ts:168-181`). A module-graph test proves none reaches
native writers except through `convergence.ts`.

Remove unconditional `invalidateCodexModelsCache()` from
`src/server/index.ts:403`; cache mutation occurs only in admitted convergence.

## Test plan

All tests use temporary homes, real contract record owner, port `0`, and production
`convergeCodex`. None invokes live CLI lifecycle commands or port 10100.

### Authority and ordering

1. Table-drive owned/foreign/unknown service evidence including corrupt,
   unreadable, conflicting, missing, unknown registration, and unresolvable paths.
2. External provider + dead markerless journal: byte-exact before/after across
   config/profile/catalog/backups/cache/history/rollouts; journal remains; no lock
   or record creation.
3. Foreign/unknown startup, ensure, API sync, teardown, and management mutation end
   before first lock event and preserve full manifests.
4. Invalid/unknown-version journal and unknown liveness preserve bytes and refuse.
5. Trace exact order through `convergeCodex`; OFF omits gather only.

### Bounded interference

1. Gather from snapshot A; cooperating config writer changes generation before
   lock. Under-lock snapshot B rejects before commit — prevention.
2. Inject a non-cooperating byte change after the final coordinated read but before
   post-commit check. Outcome is deferred/preserved and a bounded retry is scheduled
   — detection, not prevention.
3. Exhaust `deadlineMs`; assert typed unresolved outcome and no unbounded loop.
4. Native expected generation with another `txId` at the same number is
   interference.
5. Stale history `CommitExpectation` is rejected before mutation.

### Provenance/restoration/recovery

1. Apply from absent and present baselines through `convergeCodex`; verify each
   contract entry precedes native write and post-image follows read-back.
2. Matching current post-image restores exact present baseline or absence.
3. Current-byte drift preserves native additions; exact structural removal occurs
   only with unambiguous provenance. Unparseable drift blocks.
4. Edit then revert to the same bytes: test only that current equality permits the
   contract action; explicitly do **not** assert no edit occurred.
5. Crash between native write and post-image record; restart preserves/refuses.
6. Lost record and corrupt record: every automatic/normal explicit convergence
   refuses and preserves bytes.
7. Operator adoption with no confirmation does nothing; confirmed isolated CLI
   flow quarantines the bad record, writes exact current present baselines through
   the owner, changes no native bytes, then normal `convergeCodex` succeeds.
8. Adoption aborts atomically on one unreadable target, external provider, live
   writer, running proxy, or noninteractive/agent-driven invocation.

### Observed state and fresh intent

1. Drive applied, absent, each one-artifact partial, external/refused, current-byte
   drift, stale rollout, and nonempty manifest states through `action:"observe"`.
2. Persist OFF with one residue at a time; unchanged config mutation still converges.
3. Persist ON with one required artifact missing; unchanged mutation reconstructs
   and re-observes.
4. One running server starts with stale ON in memory; a subprocess persists OFF;
   `/api/sync` removes through fresh admission. Subprocess persists ON; same server
   gathers/applies without restart. Invalid config refuses/no write.
5. Route assertions use `toSyncResponse`; no duplicated status table.

### Production funnel

Walk static/dynamic imports, aliases, wrappers, and re-exports. Every lifecycle and
management native writer must be reachable only through `convergence.ts`. Grepping
for `convergeCodex` alone is insufficient (`005_contract.md` §Test plan).

## Verification

```bash
bun run typecheck
bun test tests/codex-ownership-authority.test.ts
bun test tests/codex-artifact-provenance.test.ts tests/codex-models-cache-restore.test.ts
bun test tests/codex-observed-state.test.ts tests/codex-convergence-order.test.ts
bun test tests/codex-journal.test.ts tests/codex-sync-api.test.ts tests/service.test.ts tests/uninstall.test.ts
bun test tests/codex-convergence-contract.test.ts
bun run test
bun run lint:gui
bun run privacy:scan
```

Live proof is the in-process server/subprocess test bound to port `0` with isolated
homes. Evidence names one server PID, two config-writer PIDs, prevention/deferred
interference traces, recovery quarantine/record hashes, and observed ON/OFF results.
A green response envelope without artifact read-back is insufficient. Never use the
live proxy on 10100.

## Accept criteria

- **C8** — exact `AdmissionSnapshot` authority precedes every artifact; foreign and
  unknown fail closed. Gather uses its config; authoritative re-read occurs inside
  coordinated commit.
- **C9** — external provider remains a separate veto and preserves all bytes.
- **C10 (narrowed)** — two contract baseline classes only. Matching current
  post-images restore; current-byte drift preserves/reports. No hash claims to prove
  absence of edit-and-revert. Lost/corrupt ledger has an explicit, confirmed,
  non-mutating adoption path; automatic behavior refuses.
- **C11** — observed state is the contract `CodexObservedState`; unchanged intent
  still converges and re-observes.
- **C12** — the same running server honors subprocess OFF then ON using a pre-gather
  snapshot and authoritative under-lock re-read; the old one-read cost claim is
  withdrawn.
- `/api/sync` calls only `convergeCodex` + `toSyncResponse`; no WP12 status/header
  owner exists.
- There is one convergence entry point and one shared result family.
- **N2** — WP12 rewires all remaining callers and passes its own typecheck/tests in
  the same commit. WP13 adds composed proof, not missing implementation.

## Explicitly open after WP12

Journal liveness still identifies a writer by PID only, so PID reuse may delay
recovery until a later journal version records a process-instance token. Terminal
provenance retention/compaction still needs a bounded policy after production
evidence. Neither gap permits fail-open mutation; preservation wins.
