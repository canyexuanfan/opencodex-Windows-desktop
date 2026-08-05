# 041 — WP12 closeout: the call edge, and the decision that did not survive review

This document owns the last stretch of WP12: the runtime `AdmissionSnapshot`
producer, tri-state ownership, and the first production caller of
`withCodexWriteLock`. It also records a design decision that was refuted before
it was implemented, because the refutation is the more useful artifact.

## D1 — proposed, refuted, replaced

### What was proposed

`admitCodexWrite()` refuses on `generation` authority in any home that has never
had a cooperating config write, because `observeConfigGeneration()` returns
`unavailable` when `config-mutation.sqlite` does not exist
(`src/codex/generation.ts:149-156`, `src/config.ts:1872-1874`). That is not only
a fixture problem: a user whose `config.json` predates the coordinator database
would have every Codex write refused permanently.

The proposal was to widen `AdmissionSnapshot.generation` to
`{ present: boolean; value: number }`, admit `present:false` when the database is
absent, and treat that as matching only `present:true, value:0` under the lock.
The justification: `withConfigMutationLockSync` opens the database with
`create: true` and calls `initializeConfigGeneration`, which inserts the
singleton at 0 (`src/config.ts:1814-1822`, `src/codex/generation.ts:24-32`), so 0
is a positive fact rather than an assumed baseline.

### Why it is wrong

An independent reviewer that did not write the code refuted both halves, and both
refutations were then reproduced directly.

**The invariant is not enforced.** `withConfigMutationLockSync` is a generic
exported lock: it initializes the generation, invokes an arbitrary callback, and
commits without bumping anything (`src/config.ts:1805-1843`). A callback may
mutate `config.json` and leave the generation at 0. The recognized writers —
`saveConfig` (`:1923-1940`), `mutatePersistedConfig` (`:2011-2021`),
`saveConfigPreservingClaudeCode` (`:2275-2283`) — do bump, but the mechanism does
not require it. "Generation 0 proves no cooperating write happened" is a
statement about today's call sites, not about the lock.

**And the rule could never have matched.** On first acquisition the
`BEGIN IMMEDIATE` that creates the table is still uncommitted while
`withCodexWriteLock` calls `readAdmissionUnderLock()`, which opens a *separate*
read-only connection (`src/codex/codex-write-lock.ts:303-305`,
`src/codex/generation.ts:158-168`). A live probe:

```text
before lock, db exists = false
before lock, observe   = {"kind":"unavailable","reason":"database"}
INSIDE lock, observe   = {"kind":"unavailable","reason":"database"}
after lock, observe    = {"kind":"ready","generation":{"value":0}}
```

The under-lock re-read cannot see `value:0`, so `absent` would never have matched
its only permitted counterpart and **every first write would have been refused as
stale**. The proposed rule was not merely unsound in theory; it was inoperative.

A second probe confirmed what does already hold: a corrupt coordinator database
fails closed at the lock itself with `ConfigMutationLockError`, so nothing here
needs to re-derive that protection.

## D1' — the replacement

1. `ConfigGenerationObservation` gains `{ kind: "absent" }`, returned **only** for
   `ENOENT` from the initial `statSync`. Permission errors, `ENOTDIR`, an invalid
   schema version, and SQLite corruption all stay `unavailable/database`. Absence
   and corruption must not collapse.
2. The under-lock re-read takes the generation from the **already-open** `C`
   transaction handle, not from a fresh observer connection. This removes the
   visibility hazard entirely rather than working around it.
3. A pre-lock `absent` authorizes a write only when that in-transaction read
   returns exactly 0.
4. `configDigest` is the primary interference authority; the generation
   corroborates it. This inverts the earlier emphasis, which leaned on a counter
   the mechanism does not guarantee.
5. **`configDigest` must actually be a byte digest, which today it is not.**
   Round 3 caught the claim in item 4 being false as written: the digest hashes
   `JSON.stringify(config)` — the *parsed* object (`src/codex/admission.ts:141-144`)
   — because `readConfigDiagnostics()` throws away the raw text it just read
   (`src/config.ts:1727-1745`). A whitespace-only or key-reordering rewrite by a
   non-cooperating writer leaves that digest identical. Having demoted the
   generation to corroboration, item 4 moved the weight onto something that
   could not carry it.

   Admission does **not** get the raw bytes. `config.ts` keeps its single-read
   owner and hands back a digest computed there:

   ```ts
   // A union, not a nullable field. `{source:"file", contentSha256:null}` is a
   // state that cannot occur, so it must not be a state that can be WRITTEN —
   // refusing it at runtime is a check somebody can forget; making it
   // unrepresentable is not.
   export type ConfigAdmissionSnapshot =
     | Readonly<{ kind: "read"; diagnostics: ConfigDiagnostics; contentSha256: string }>
     | Readonly<{ kind: "unreadable"; diagnostics: ConfigDiagnostics; contentSha256: null }>;
   export function readConfigAdmissionSnapshot(): ConfigAdmissionSnapshot;
   ```

   One `readFileSync` into a Buffer, hashed exactly as read — BOM and whitespace
   included — then decoded once for `configDiagnosticsFromRaw`. No second read,
   so no torn read between them.

   Exporting `readConfigFileSnapshot()` instead would put `raw` in a caller's
   hands, and that string carries provider API keys and admission keys.
   `privacy:scan` would not catch it: it scans tracked source text from
   `git ls-files` (`scripts/privacy-scan.ts:51-67,187-229`), not runtime values.
   The raw-bearing helper stays private.

### The comparator, which D1' at first also omitted

A second audit round found that D1' fixed the SQLite visibility hazard and then
failed for a different reason one layer down. The lock compares
`authoritySnapshotId` byte-for-byte (`src/codex/codex-write-lock.ts:303-307`) and
the generation participates in that hash (`src/codex/admission.ts:173-184`), so
`{present:false}` and `{present:true,value:0}` still produce different IDs — and
every first write is still refused. Fixing the read direction was necessary and
not sufficient.

So the hash **canonicalizes the two into one authority token**:

```ts
// Absent and present-zero are the SAME authority: both mean "no committed
// cooperating write has happened". They must hash identically or the
// comparison refuses every first write. Any value >= 1 hashes as itself.
generationAuthority(g) = g.present && g.value > 0 ? `gen:${g.value}` : "gen:0"
```

Canonicalizing inside the hash is chosen over a special-case comparator beside
it, because a comparator that treats one field specially has to be reimplemented
at every future comparison site, and the one that gets forgotten is the one that
matters.

### Why exactly zero, and nothing else, is reachable

Once our `BEGIN IMMEDIATE` succeeds (`src/config.ts:1820`) no cooperating process
can create or bump concurrently — every generation mutation runs inside a SQLite
write transaction (`src/codex/generation.ts:110-122,176-185`). So after a pre-lock
ENOENT the in-transaction read can only be: 0 when nobody committed a bump
(including a creator that rolled back, and a creator that initialized without
bumping), or >= 1 when someone committed one. A competing holder makes our own
acquisition busy instead, and the callback never runs. Zero is therefore the only
value consistent with "no committed bump survived", which is exactly the claim
being made — and no more than that, which is why `configDigest` still carries the
byte-level authority independently.

### Consumers

`tests/codex-config-generation.test.ts:107-117` currently pins absence to
`unavailable/database`, and its comment states the reason: a caller that may only
look must not receive something it could mistake for a known-good zero. D1' pays
that debt rather than deleting it — the observer may report `absent`, but it is
promoted to a usable zero only after `C` is held and a real zero is read there.

`admitCodexWrite` is not the only consumer. `captureCatalogAdmissionSnapshot`
(`src/codex/catalog-admission.ts:141-144`) also reads the observation and formats
`generation.reason`, a field `absent` does not have — so it breaks at compile
time unless it gains an explicit branch. It keeps refusing on absence: WP9 gather
has no lock to promote an absence inside, so for that caller absence remains a
refusal and the widened union simply forces the case to be stated.

## D2 — ownership is tri-state, and the existing helper cannot supply it

`assertNativeTeardownOwned()` returns `{ ok: true }` when the service state file
is unreadable (`src/integrations/native/ownership-preflight.ts:31-34`). Failing
open is correct for a teardown route, whose own input being broken should not
wedge the route. Projecting that same answer into `ownership: "owned"` would turn
"could not be read" into "belongs to me" — the absence-as-guarantee defect this
unit has now found seven times.

So `inspectNativeCodexOwnership()` is added alongside, returning
`owned | foreign | unknown`, and unattended convergence refuses on both `foreign`
and `unknown` without creating any artifact. The teardown helper keeps its
fail-open behavior and its callers.

## The call edge

`withCodexWriteLock` has had zero production callers since it was written, which
is defect #10 of this unit and the reason WP11 was folded into WP12. A mechanism
with no consumer cannot be exercised except through a fabricated object.

`injectCodexConfig` (`src/codex/inject.ts:487`) is the edge. The naive reading —
"wrap `:601-603`" — is wrong, and the audit caught it: **`writeJournal()` already
runs at `:530`**, well before that block, and it performs an atomic write
(`src/codex/journal.ts:60-82`). Wrapping only the tail would leave the first
artifact-creating write outside the lock, which is not exclusivity; it is a
shorter unprotected window.

The lock therefore opens **before `writeJournal`** and closes after
`markJournalInjectedState`, covering the journal write, both `atomicWriteFile`
calls, and the injected-state marking as one section. Everything before that
point in the function is classification and refusal, which creates nothing. The
awaited history job at `:614` stays **outside**: it has its own cross-process
lock (WP10) and the `N -> H` order is deliberate. Production reaches this
function from `src/codex/sync.ts:58,110` and `src/cli/init.ts:197`.

### The external-provider branch, and the fix that could not work

"Open the lock before `writeJournal`" does not cover the external-provider path
at all: that branch **calls `removeJournal()` at `:497` and returns at `:503`**,
never reaching `writeJournal`. `removeJournal` unlinks
(`src/codex/journal.ts:93-95`). The one path whose entire purpose is "someone
else owns this config, do not touch it" was performing an unguarded destructive
write.

The obvious repair — move the deletion inside the lock — was written here and
then refuted, because it is **internally impossible**. Admission refuses
external-provider, so no admitted snapshot exists; `withCodexWriteLock` requires
one. A refused admission cannot authorize a locked deletion. The sentence was
self-contradictory and survived a round only because nobody traced it.

Refusing outright is also a regression, and a user-visible one. Today the branch
returns `success: true` with preservation guidance (`src/codex/inject.ts:492-509`)
and `syncModelsToCodex` projects that straight into `ok` (`src/codex/sync.ts:56-70`).
Tests pin it: `tests/codex-inject-integration.test.ts:247-309,358-384` and
`tests/codex-sync-api.test.ts:227-263`. Turning it into a failure would take
`/api/sync` from 200 to 500 (`src/server/management/config-routes.ts:261-268`),
give `ocx sync` exit 1 (`src/cli/index.ts:840-846`), and turn `ocx init`'s
checkmark into a warning (`src/cli/init.ts:194-199`).

So the resolution is neither: the external-provider admission refusal maps to
the **existing successful no-op**, and the branch preserves config, profile,
history *and the journal*. The stale-journal deletion is a separate operation
needing its own authority contract, and it does not ride along inside a write
path that was never admitted. A6b therefore asserts the journal survives
byte-identical, which is the opposite of what this document said one round ago.

### The journal admission was hashing does not exist

`admitCodexWrite` records the journal at
`join(getConfigDir(), "codex-journal.json")` (`src/codex/admission.ts:120-121`),
but the real journal is `join(CODEX_HOME, "opencodex-journal.json")`
(`src/codex/journal.ts:6-9`). Different directory, different filename. So
`journalIdentity` was watching a path nothing writes, and would have reported a
serene `absent` while the actual journal was rewritten underneath the lock. The
test at `tests/codex-admission.test.ts:157-164` reproduced the wrong location,
which is how it stayed invisible: the fixture and the producer agreed with each
other and both disagreed with production.

This is the same failure the unit keeps finding, in a new place — a check whose
subject is not the thing being protected. `canonicalTargets.journal` becomes the
real path, and its test asserts against `journal.ts`'s own constant rather than
re-deriving the path by hand.

## Acceptance

| # | Claim | Evidence |
|---|---|---|
| A1 | A first write on a coordinator-less home SUCCEEDS end to end | Not merely that admission returns `admitted`: `withCodexWriteLock` reaches and completes its commit callback with a pre-lock `absent` |
| A2 | BYTE interference is caught without any generation change | **R1c.** A whitespace-only rewrite — no semantic change, no bump — still yields `authority_not_proven`. A semantic-edit test cannot satisfy this one |
| A2p | The PRIMITIVE that A2 rests on | **R1a.** A whitespace-only rewrite changes `contentSha256` and therefore `hashAuthority`, proven at the function level. R1a cannot reach `authority_not_proven` — that needs an admitted snapshot, which needs truthful ownership, which is R1b |
| A2b | Committed-bump interference is caught | **R1c.** A competing cooperating write between admission and commit yields `authority_not_proven` |
| A3 | Absence is not corruption, at both layers | Only `ENOENT` reports `absent`; a corrupt DB refuses at the observer AND fails closed at lock open |
| A4 | Admission creates nothing and destroys nothing | A pre-seeded journal, config, profile, catalog, service-state and integration record all survive byte-identical; no `config-mutation.sqlite`; directory modes unchanged |
| A5 | Unknown ownership refuses on the OWNERSHIP authority | Generation warmed first so the run cannot be refused earlier for another reason; assert the exact authority |
| A6 | External provider is its own veto | With ownership proven `owned`, the refusal authority is `external-provider` |
| A6b | The external branch stops destroying the journal | A pre-seeded journal survives BYTE-IDENTICAL through the REAL `injectCodexConfig` external path, and the call still returns `success: true` with its preservation message |
| A7 | The lock has a live production caller | `rg` reachability PLUS a test that observes the lock being taken on the real `injectCodexConfig` path |
| A8 | The edge is exclusive across processes | A barrier held inside the acquired lock; the loser reports `busy` and its PROCESS-UNIQUE candidate bytes are absent from the final file, so the winner is provable rather than assumed |
| A9 | The whole native section is inside, history is outside | An ordered trace showing journal write, config write, profile write and marking all between acquire and release, and the history job after release |
| A10 | `journalIdentity` tracks the real journal | The identity changes when `journal.ts` writes, asserted against an EXPORTED constant from `journal.ts` — `JOURNAL_PATH` is private today (`src/codex/journal.ts:8`), and a re-derived test path is how the current mismatch stayed invisible |

A1 additionally asserts the transition was **published**, not merely that the
callback returned; A2/A2b place the competing edit at a barrier *after* admission
and *before* acquisition, or the race proves nothing; A5 gains the two ENOENT
corroboration cases; A7 must observe the real lock rather than a spy.

Each acceptance row is tagged with the phase that can actually prove it. The
distinction between A2 and A2p is the one that took a round to see: R1a builds
the digest that makes byte interference *detectable*, but it cannot demonstrate
the *refusal*, because a refusal requires an admitted snapshot and admission
cannot honestly admit anything until ownership stops being hardcoded. Claiming
A2 in R1a would have meant proving it against the placeholder.

Every mechanism above gets a broken-change check: mutate it, watch the test go
red, restore, and confirm `git diff --stat` is empty. A green suite is not
evidence in this unit — roughly 8400 tests pass today beside the defects it
fixes. Each check is recorded by name — the mutation applied, the test that went
red, and the restored-clean confirmation — because an unrecorded mutation check
is indistinguishable from one that was never run.

## D2 — the tri-state, and why `null` is not one state

`readServiceInstallState()` returns `null` for a fresh machine with no service,
for an unreadable file, for invalid JSON, and for JSON that fails schema
validation alike (`src/service.ts:165-175`, schema at `:127-141`). Mapping `null`
to either pole is wrong in one direction or the other: call it `unknown` and
every fresh machine refuses; call it `owned` and a corrupt state file becomes a
licence to write.

So the distinction is drawn from the file evidence rather than from the parsed
result:

| Evidence | Ownership |
|---|---|
| Every known state path is ENOENT, **and the service manager shows no installation** | `owned` — an uncontested home |
| Every known state path is ENOENT, but the service manager shows an installation, a conflict, or cannot be read | `unknown` |
| Readable, valid, both homes match | `owned` |
| Readable, valid, homes differ | `foreign` |
| Present but unreadable, malformed, or schema-invalid | `unknown` |
| Two valid states that disagree | `unknown` |
| A valid state beside an unreadable one | `unknown` |

Known paths and the current home pair come from `src/service.ts:82-107`, and
normalization from `:109-112`. The detailed inspection belongs in `service.ts`;
`inspectNativeCodexOwnership()` only projects it. `assertNativeTeardownOwned()`
is untouched at `src/integrations/native/ownership-preflight.ts:21-35` — its
fail-open behavior is correct for the teardown routes that call it.

The service-manager corroboration is the round-3 correction, and it is the same
defect one layer out: installs write state to both the current and the default
home (`src/service.ts:90-95,144-160`), so a mere `OPENCODEX_HOME` change is
already caught by the default mirror — but all-paths-ENOENT *also* describes a
machine whose state files were deleted while the service is still installed and
running. Reading that as `owned` would be absence-as-guarantee again, in the one
place where being wrong means writing over a live installation's home.

Round 4 then found that the probe this requires does not exist yet. Windows is
adequate — `schtasks` already returns `present|absent|unknown`
(`src/service.ts:761-788`) and WinSW treats only error 1060 as proof of absence
(`src/lib/winsw.ts:209-266`). macOS and Linux are not: `launchdJobMatchesPlist`
maps every failed `launchctl print` to `loaded:false` (`src/service.ts:577-600`),
and the systemd helpers collapse any command failure to empty
(`src/service.ts:2000-2042`). Both turn "could not ask" into "not installed",
which is the exact inversion this table exists to prevent. A new fail-closed
probe is needed:

```ts
export type ServiceManagerInstallation =
  | { kind: "absent" }
  | { kind: "present"; backend: "launchd" | "systemd" | "scheduler" | "winsw" }
  | { kind: "conflict" }
  | { kind: "unknown"; reason: string };
export function inspectServiceManagerInstallation(): ServiceManagerInstallation;
```

On Linux, `systemctl --user show -p LoadState --value opencodex-proxy` gives the
three-way answer directly: a known load state is present, an explicit
`not-found` is absent, and a bus or parse failure is unknown. Every probe is
read-only — the user's proxy is live, and nothing here may start, stop, or
reload it.

## This is three work-phases, not one

Round 4's closing finding, accepted: the plan now spans three independent
failure domains, and combining them would make a failure in one impossible to
localize or revert.

| Phase | Owns | Regression surface |
|---|---|---|
| WP-R1a admission substrate | single-read byte digest, `absent` observation, transactional generation read, canonical hash, catalog consumer branch, real journal path | config read path, WP9 catalog admission |
| WP-R1b ownership evidence | detailed service-state reads, the new tri-state manager probe on three platforms, projection to `owned/foreign/unknown` | service diagnostics on every platform |
| WP-R1c production activation | the `injectCodexConfig` lock boundary, external-provider compatibility, ordered history handoff, the two-process race | `ocx start`, `ocx sync`, `ocx init`, `/api/sync` |

Only WP-R1c can claim the lock has a production caller, and it depends on both
of the others. That dependency order is the phase order.

## Deferred, with issues rather than silence

WP13 (the composed acceptance suite, `050_composed_acceptance.md`) and WP14 do
not land here. They become GitHub issues so that `dev` carries an honest record
of what is proven and what is not: the lock's production edge is demonstrated by
a real two-process race, but the composed suite that would exercise every entry
point together is still outstanding.
