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

`injectCodexConfig` (`src/codex/inject.ts:491`) is the edge. The naive reading —
"wrap the two `atomicWriteFile` calls" — is wrong, and the audit caught it:
**`writeJournal()` already runs at `:534`**, seventy lines before them, and it
performs an atomic write (`src/codex/journal.ts:69-90`). Wrapping only the tail
would leave the first artifact-creating write outside the lock, which is not
exclusivity; it is a shorter unprotected window.

Line numbers here track `origin/dev` at `468587632`, after #1022 and #1000
landed. They move; the anchors — `writeJournal`, the two `atomicWriteFile`
calls, `markJournalInjectedState`, and `runCodexHistoryJob` — do not.

The lock therefore opens **before `writeJournal`** (`:534`) and closes after
`markJournalInjectedState` (`:607`), covering the journal write, both
`atomicWriteFile` calls (`:605-606`), and the injected-state marking as one
section. Everything before that point in the function is classification and
refusal, which creates nothing. The awaited history job stays **outside**: it has
its own cross-process lock (WP10) and the `N -> H` order is deliberate.
Production reaches this function from `src/codex/sync.ts:58,110` and
`src/cli/init.ts:197`.

### What else lives inside that span

The span is wider than the three writes, and an audit caught me claiming
otherwise. PR #1022 (tri-state `fastMode`, now landed as `ebcfff44f`) changes two
call sites — `ensureFastModeFeature` at `:555` and `buildProfileFile` at `:603` —
and I argued they sat outside the lock because the first is "before the writes".
They are not: `writeJournal` opens the span at `:534` and both changed lines fall
after it.

The order still holds, with a different reason. Landing #1022 first is right not
because it avoids the section but because WP-R1c should be written against the
function's final shape rather than against a version about to change underneath
it. Both transforms are pure and bounded, so they compose inside the callback;
what would have been wrong is discovering that during implementation instead of
before it.

A second reviewer caught the sentence that stood here, which claimed nothing in
the span may be non-deterministic or IO-bearing. That is plainly false: the span
*is* the IO — journal writes, two atomic file replacements, and the marking that
follows them. The real constraint is narrower: nothing in the span may perform IO
the journal does not account for, because the restore path replays only what the
journal recorded.

`buildProfileFile` with an unset `fastMode` now emits different bytes, and that
stays safe because the journal captures the original profile before the write
(`src/codex/journal.ts:69-90`) and records the exact new one after
(`:93-107`); restore replays the captured original (`:128-141`). The comparison
is against what was actually written, not against what the generator would
produce today.

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
| Every known state path is ENOENT, **and no manager definition exists on disk, and no registration is loaded** | `owned` — no persistent service claim observed |
| Every known state path is ENOENT, but a manager definition exists, a registration is loaded, or either cannot be asked | `unknown` |
| Readable, valid, both homes match, **and any manager definition names the same homes, and the loaded registration matches that definition** | `owned` |
| Readable, valid, homes differ | `foreign` |
| Readable and valid, but a manager definition names DIFFERENT homes | `unknown` — an interrupted reinstall, not a decision to make unattended |
| Definition and state agree, but launchd/systemd is running an OLDER definition, or the registration cannot be read | `unknown` |
| Present but unreadable, malformed, or schema-invalid | `unknown` |
| Two valid states that disagree | `unknown` |
| A valid state beside an unreadable one | `unknown` |
| Two managers both proven present (Windows scheduler + WinSW) | `unknown` (`conflict` at the probe) |

`readServiceInstallState` cannot answer this: it returns the FIRST valid state
and discards every later path (`src/service.ts:165-175`), so a valid mirror
beside a corrupt one reads as clean. The projection needs an all-paths evidence
API that reports what each path said, not the first thing that parsed.

The "older definition" row is not hypothetical: `startLaunchd` already
distinguishes it and tells the user to `bootout` and reinstall
(`src/service.ts:1655-1667`). Disk and live can disagree, so reading the disk
definition alone leaves the same hole one layer in.

### What this table does NOT prove

`owned` here means **no persistent service claim was observed**. It does not
mean this process is the only writer: two foreground `ocx start` processes on
one home both read `owned`, correctly, because neither installs a service.
Exclusion between them is the write lock's job (WP-R1c), and deciding a
sequential takeover between different `OPENCODEX_HOME`s is provenance's job
under that lock. Reading this row as exclusivity would be borrowing a guarantee
from a phase that has not run.

### The race this cannot close

Admission re-reads under the lock, but `writeServiceInstallState` and the
definition writes (`src/service.ts:1610-1625`, `:2017-2021`) do not take that
lock, so a definition can appear immediately after the probe looked. Reading the
definition bytes twice around the registration check narrows the window and
detects an A-B-A, but detection is not prevention: closing it requires
install/uninstall/repair to take the same authority lock. That is a real
follow-up, recorded rather than papered over — the probe reports what it saw,
and does not claim the world held still while it looked.

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

A sixth round replaced that shape too. `{ backend }` tells a caller which manager
answered, which is not the question either — the caller needs the homes the
definition names, so that comparing them is the projection's job rather than a
verdict the probe hands down:

```ts
type ServiceManagerClaim = {
  backend: "launchd" | "systemd" | "scheduler" | "winsw";
  definitionPath: string;
  homes: { codexHome: string; opencodexHome: string };
  registration: "present" | "absent";
};

type ServiceManagerInstallation =
  | { kind: "absent" }
  | { kind: "present"; claims: readonly [ServiceManagerClaim, ...ServiceManagerClaim[]] }
  | { kind: "conflict"; claims: readonly ServiceManagerClaim[] }
  | { kind: "unknown"; reason: string };
```

On Windows the "definition" is a chain, not a file. The task XML names only the
launcher (`src/service.ts:1450-1458`); the homes live in the batch wrapper it
eventually runs (`:1358-1366`). A probe that parsed the XML and stopped would
read a definition that mentions neither home and conclude they match by default.

### Registration is not the question; the definition is

A fifth round rejected that sketch, and the reason reframes the whole probe.
**Asking whether a job is currently loaded answers the wrong question.**

Installation writes the definition FIRST and the state file after
(`src/service.ts:1610-1625` on macOS, `:2017-2021` on Linux), and the definition
itself embeds `CODEX_HOME` and `OPENCODEX_HOME` (`:276-284`, `:1948`). So an
interrupted reinstall leaves a valid state file for home A beside an installed
plist for home B — and a probe that only asks "is a job loaded?" calls that
`owned`. Worse on macOS: a logged-out user has the plist on disk with no GUI
domain at all, so the registration probe reports nothing loaded while a foreign
definition sits right there.

The probe therefore reads the **definition**, and compares the homes inside it:

| Platform | Definition | Registration |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.opencodex.proxy.plist` (`:56-59`) | `launchctl print` |
| Linux | `~/.config/systemd/user/opencodex-proxy.service` (`:1935-1941`) | `systemctl --user show` |
| Windows | Task Scheduler XML / WinSW config | `schtasks /query`, `sc query` |

Absence requires BOTH: no definition on disk AND no registration. Either one
present, or either one unaskable, is not absence.

### Measured exit codes, and the one that is not a code at all

macOS distinguishes the two cases, verified against nonexistent targets rather
than assumed:

```text
launchctl print gui/<uid>/<no-such-label>  -> exit 113  "Could not find service ... in domain"
launchctl print gui/999999/<label>         -> exit 112  "Could not find domain for user"
```

113 is "definitely not registered"; 112 and everything else is "could not ask".
`runLaunchctl` currently discards the numeric status and keeps only a boolean
(`src/service.ts:551-565`), so the probe needs a variant that preserves it —
classifying on stderr text alone would rest on output Apple does not treat as a
stable interface.

Linux does NOT signal through the exit code, which is the trap a code-based
design would have fallen into:

```text
systemctl --user show -p LoadState --value opencodex-proxy  ->  "not-found", exit 0
```

A missing unit exits **zero**. The value carries the answer and the exit code
carries only whether the question reached the bus. `LoadState` alone is also
insufficient — it is orthogonal to `ActiveState`, so the probe asks for
`LoadState`, `ActiveState` and `FragmentPath` together and calls absence only
when the unit is inactive AND has no fragment.

Those three still cannot tell whether the LOADED bytes match the file, which is
the systemd form of the stale-plist case. `NeedDaemonReload` is exactly that
signal, and this repository already documents it as "the systemd analogue of
launchd's stale-plist case" (`src/service.ts:2023-2031`) — writing the unit file
does not change what systemd has loaded until `daemon-reload`. So the query
includes it, and `yes` — or a value that cannot be read — is `unknown`.

### An unreadable definition is not a present one

`present` carries parsed `homes`, so an artifact that cannot supply them cannot
be `present`. A definition that exists but is unreadable, truncated, or dangling
maps to `unknown`, not `present` with the homes left blank or guessed. Blank
homes would compare equal to nothing and the projection would read them as
agreement.

### Every probe is bounded and read-only

`spawnSync`/`execSync`/`execFileSync` in this module carry no timeout
(`src/service.ts:533,551,631`), so a wedged service manager would block the
event loop. Each probe gets a short timeout, and a timeout maps to `unknown`
like any other unanswered question.

The allowlist is enforced by an injected runner that records executable and
argv: `print`, `show`, `/query`, `sc query` and nothing else. The user's proxy
is live under launchd, so a probe that could start, stop or reload anything is
not a probe. Asserting this from the source text is not enough — this unit has
already shipped a "fix" that was only a comment — so the test drives each verb
to a mutating one and requires the assertion to fail.

### Three ways this could pass while broken

Named by the audit, and each answered by a specific assertion rather than by
care:

| False pass | What the test must do instead |
|---|---|
| Inspect only disk definitions and miss a stale LOADED one | Assert the older-definition row: disk and live disagree, result is `unknown` |
| Parse the Task Scheduler XML and stop, never following it to the batch wrapper where the homes actually are | Assert the parsed `homes` against a fixture whose XML and wrapper name DIFFERENT homes |
| Mutation-test the fake argv the harness supplies rather than the argv production emits | The recorder observes the PRODUCTION probe's emitted argv; mutating the fixture must not be able to satisfy it |

### `conflict` is reachable

It is not decorative: Windows can have both a Task Scheduler registration and a
WinSW service proven present at once, a combination the existing code already
names (`src/service.ts:829`). The combinator states it rather than picking a
winner.

### Windows already wrote this down

`probeWindowsSchedulerTask` (`src/service.ts:766-788`) is the pattern, and its
own comment states the reason: "if both fail, returns `unknown` so callers can
fail closed instead of releasing locks." It tries the specific query, falls back
to a CSV listing, and only concludes absence when a listing succeeded without
the task in it. WinSW is equally careful — only error 1060 proves absence
(`src/lib/winsw.ts:209-266`).

So this phase does not invent a convention. It brings two platforms up to one
that already ships:

| Platform | Today | Why it is wrong |
|---|---|---|
| launchd | every failed `launchctl print` becomes `loaded:false` (`src/service.ts:594`) | permission denial, a bad domain, and a missing `launchctl` all read as "not installed" |
| systemd | `sh()` failures are swallowed by `catch` (`src/service.ts:2036-2043`) | no user bus reads as "nothing here" |
| Windows | `present \| absent \| unknown` | — |

`runLaunchctl` already returns `{ ok, stdout, stderr }` (`src/service.ts:551-565`),
so the evidence exists and is being discarded one layer up. The new probe keeps
it. `launchdJobMatchesPlist` itself is left alone: its callers want a boolean for
staleness diagnostics, and widening it would change behavior this phase has no
business changing.

### The probes may not touch the running service

`launchctl print`, `systemctl show`, `schtasks /query` and `sc.exe query` are all
read-only, and that is not incidental. This machine has a live proxy on port
10100 under launchd. A probe that started, stopped or reloaded anything to
determine installation would take down the user's running proxy to answer a
question about whether it exists.

### "Cannot ask" is not one state — the correction that saves fresh machines

A second reviewer found the flaw that would have made this change worse than the
bug it fixes. If every unanswerable probe returns `unknown`, and `unknown`
refuses, then **a fresh machine with no service manager reachable refuses every
Codex write** — headless macOS with no GUI domain, a container with no user bus,
a Linux box with no systemd at all. Those are ordinary environments, not
contested ones.

The escape is that not all silence is equal. Some failures prove the backend
*cannot exist here*, and that is positive evidence of absence rather than a hole:

**The disk artifact is consulted FIRST, on every platform, and it can only ever
raise the verdict.** A second audit round caught me applying that rule to
launchd and then reasoning about Linux as though a systemd unit were not also a
file. It is: `~/.config/systemd/user/opencodex-proxy.service`, written BEFORE
`daemon-reload`, `enable`, `restart` and the state file (`src/service.ts:1936,2017-2022`)
— the same ordering that makes the launchd plist outlive a failed install.

So "backend impossible" never overrides a residue on disk:

| Observation | Verdict | Why |
|---|---|---|
| unit file or plist present (or `lstat` fails for any reason other than ENOENT) | at least `present` | an interrupted install leaves it, and it activates on the next login or boot |
| `systemctl` not invocable AND no unit file | `absent` | no unit to load, and nothing here can load one |
| `/run/systemd/system` missing AND no unit file | `absent` | systemd is not the init here and left nothing behind |
| `systemctl --user show` exits 0 with `not-found` | `absent` | the manager answered |
| `systemctl --user show` exits nonzero (bus unreachable) | `unknown` | a user manager may hold a unit we cannot see |
| `launchctl print` exits 113 | `absent` | measured on macOS 27.0: "Could not find service ... in domain" |
| `launchctl print` exits 112 AND no plist | `absent` | the GUI domain itself does not exist, and nothing is staged to load |
| `launchctl print` exits 112 AND a plist exists | `unknown` | something is staged and we cannot see whether it is loaded |
| `/bin/launchctl` cannot be spawned AND no plist | `absent` | not macOS, or no launchd to hold a job |
| not this platform's backend, no artifact | `absent` | that backend has no installer here |

The `112 + no plist` row is the one that decides whether a fresh headless Mac
works at all. The earlier draft said 112 was always `unknown` while also
claiming headless machines were saved; both could not be true. 112 means the GUI
domain does not exist — there is no domain that could be holding a job — so with
nothing staged on disk that is absence, not silence.

That reading was challenged on the grounds that a job loaded from a
since-deleted plist could survive, and it was settled by measurement rather than
argument. On macOS 27.0:

```text
launchctl print gui/<uid>/com.opencodex.proxy      -> 0    (live job)
launchctl print gui/<uid>/com.nonexistent.whatever -> 113  (domain answered: no such service)
launchctl print gui/999999/com.opencodex.proxy     -> 112
launchctl print gui/999999/com.nonexistent.whatever-> 112
launchctl print gui/999999                         -> 112  (no label at all)
launchctl print gui/<uid>                          -> 0
```

112 is an answer about the DOMAIN and does not depend on the label — querying
the domain with no service name at all still returns it. 113 is service-scoped
within a domain that answered. So the orphan-job case (a job still loaded after
its plist was removed) lands in the exit-0 quadrant, where the manager reports
it; it cannot hide behind a 112, because a domain that cannot be reached is not
running anything on our behalf.

`existsSync` is not sufficient for the artifact check. A dangling symlink or an
unreadable path answers "no" to it while still being residue, so the probe uses
`lstat` and treats every error EXCEPT `ENOENT` as `present`.

Measured rather than assumed. On macOS 27.0 the three launchd cases return 0,
113 and 112; on Linux `systemctl --user show -p LoadState --value` exits 0
printing `not-found` for a missing unit and exits 1 with "Failed to connect to
bus" when the bus is gone. Both platforms separate "answered no" from "could not
ask" by exit status, so neither depends on message parsing.

### `runLaunchctl` discards the number this needs

I wrote that the evidence "already exists and is being discarded one layer up".
That was wrong about launchd. `runLaunchctl` collapses `result.status` into
`ok: result.status === 0` (`src/service.ts:560-564`), so 113 and 112 arrive
indistinguishable. Depending on stderr text instead would mean parsing
undocumented, localizable output — exactly what this design says it avoids.

The result type gains `status: number | null`. Existing callers read `ok` and are
unaffected; `launchdJobMatchesPlist` keeps its boolean shape.

### Windows fails closed, and that is the honest answer

There is no backend-impossible escape on Windows: `schtasks` and `sc.exe` are
always present. On a locked-down host where the SCM query is denied and the
scheduler query cannot prove absence, ownership is `unknown` and automatic
convergence refuses.

That is accepted rather than worked around. The local scheduler XML is written
before registration (`src/service.ts:1700,1727`) and WinSW assets can outlive an
SCM registration that still exists (`src/lib/winsw.ts:219`), so neither is
authoritative — inferring absence from a generated file we wrote ourselves is
precisely the mistake this table exists to prevent. The refusal carries the
probe's reason so the user can act on it.

### The plist outlives the job

A second launchd hazard: the installer writes the plist BEFORE loading it and
writes service state only AFTER a successful load (`src/service.ts:1613-1629`).
An interrupted install therefore leaves a plist on disk, no loaded job, and no
state file — and a job-only probe calls that uncontested, while the plist will
load with foreign homes baked in at next login.

So the launchd probe reads BOTH: `~/Library/LaunchAgents/com.opencodex.proxy.plist`
on disk, and the loaded job. A plist present with no job is `present`, not
`absent`.

### `conflict` is reachable, and it is Windows

`conflict` is not decorative. The scheduler task and the WinSW registration can
both exist — the code already names that state (`src/service.ts:829`) and already
queries both because a failed backend switch can leave both installed
(`src/service.ts:2211`). Manager conflict overrides to `unknown` for admission:
two managers claiming one home is exactly the case where writing is unsafe.

Three more rows the first draft missed, all evidence loss rather than ownership:

| Case | Verdict |
|---|---|
| a valid state file beside a MISSING mirror | `unknown` — installs write every mirror (`src/service.ts:155`), so one missing is loss |
| manager backend disagrees with `state.backend` | `unknown` |
| scheduler and WinSW both present | `unknown` |

### External provider must be read first

Ownership currently runs before external-provider detection
(`src/codex/admission.ts:98-116`). Making ownership stricter would hand an
external-provider user an opaque `service-home` refusal instead of the actionable
"you pointed Codex somewhere else" message. Both reads are read-only and neither
depends on the other, so the external-provider check moves FIRST. Acceptance A6
as originally written could not have caught this, because it proves ownership
`owned` before testing the provider veto.

### The systemd probe may not edit the process environment

`ensureUserBusEnv()` repairs `XDG_RUNTIME_DIR` by mutating `process.env`
(`src/service.ts:1994`). Admission documents itself as read-only, and while an
environment variable is not a file, "reads only" that quietly rewrites its own
process is the kind of almost-true this unit keeps finding. The probe passes a
derived environment to the `systemctl` child instead.

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
