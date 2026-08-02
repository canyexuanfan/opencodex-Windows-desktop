# 080 — CI stabilization after the feature landed

The feature is on `origin/dev`, every macOS gate green, and Cross-platform CI
red. This document is the stabilization unit: what failed, why, and what each
work-phase must prove.

## The evidence

Run `30757205162` (push of `68fe94eda`, "Cross-platform CI", job `windows`):
**7222 pass / 6 skip / 24 fail**. Ubuntu and macOS legs pass the same suite —
the failures are platform-specific, not logic-specific.

A red `dev` predates this feature: run `30738272930` on `release: v2.10.0`
failed the same job before any integration code existed. Attribution is
therefore per-failure evidence, never "it was already red" or "it must be mine".

## WP-S1 — the 24 Windows failures

Three root causes, not twenty-four bugs.

### 1. Hermes does not live at `~/.hermes` on Windows (20 tests)

`hermesHomeDir` resolves `%LOCALAPPDATA%\hermes` on `win32`
(`src/clients/config-export.ts`). `tests/integrations-writer.test.ts` created
`join(home, ".hermes")` and handed the writer a `home` whose detector directory
did not exist, so `applyIntegration` refused `not_installed` and every
dependent assertion fell over — the whole apply/disable/restore/nothing-leaks
surface.

The fixture now asks the registry (`spec.detectDir` / `spec.configPath`), which
is what `tests/management-integration-routes.test.ts` already did. The same
assumption existed twice in `tests/integrations-invariants.test.ts`; both sites
now use one `installClient()` helper.

**This is a fixture bug, not a source bug.** The registry was right the whole
time; the tests encoded a layout it never promised.

### 2. Three assertions spelled the separator by hand

```
Expected: "/tmp/h/config.yaml"
Received: "\tmp\h\config.yaml"
```

`hermesConfigPath`, `kimiConfigPath` and `gajaeConfigPath` were compared to
literals. The claim each test makes is *the override wins* / *this is the
documented destination* — not *paths use forward slashes*. They compare against
`join(...)` now, so the property holds on both platforms and a genuine
destination change still fails them.

### 3. The CSRF test needed a GUI bundle CI does not build

`ci.yml` installs dependencies and runs `bun test --isolate tests`; it never
runs `build:gui` first, so `gui/dist` is absent and `serveGuiFile` has no page
to inject `opencodex-session-token` / `opencodex-session-csrf` into. The test
read empty strings. It passed locally only because a stale build sat on disk —
the same class of false confidence the WP5/WP6 audit kept finding.

There is no wire route to mint a GUI session without that page, and issuing one
from a fresh `initializeManagementAuthState` returns a token bound to a
different session map than the running server's, which would make the
assertions meaningless. So the no-bundle case returns early with the absent
bundle **asserted** (`existsSync(...)` is `false`, via `fileURLToPath` — a
Windows URL `.pathname` is `/D:/...` and would make the guard vacuous).

The ordering claim the test exists for — admission runs before dispatch — stays
covered on those platforms by the admin-token test directly above it, which
drives the same real listener.

Verification for this one is local and exact: move `gui/dist` aside, re-run,
22 pass / 0 fail.

### Not ours: the 24th failure

`tests/codex-prompt-adopt.test.ts` → `salvage > preview returns a directory,
not a reserved filename`. `previewSalvage` computes
`storePath.slice(0, storePath.lastIndexOf("/") + 1)`, which never matches a
backslash path, so `backupDir` comes back `"."` on Windows and the
`endsWith("/")` assertion fails.

That is a **real source bug on Windows**, in `src/codex/prompt-layers.ts` —
explicitly out of this unit's write scope and owned by another session's work
(`ca087b591`, `9bb410ab3`, `d70fde4d9`). Reported, not patched: silently
touching another stream's file is how two sessions start overwriting each
other. Fixing it needs `dirname()` and a separator-agnostic assertion.

## WP-S2 — attribution

Inspect every job of the run that follows `7a8323c0a`, not just Windows. For
each remaining failure, record whether it is feature-caused (fix it) or
pre-existing (name the earlier failing run id). "Already red" is not
attribution.

## WP-S3 — semantic stabilization

Every phase is landed now, so the contract can be read end to end for the first
time: registry → writer → routes → GUI → CLI, across all six clients. Look for
drift the per-phase audits could not see because the later half did not exist.

## WP-S4 — types and docs

Typecheck strictness over the feature surface, escape-hatch review, docs-site
build, and the unit's own `check-drift` / `check-blocks`.

## Rule for this unit

A test that cannot run on a platform is skipped with a stated specific reason.
Narrowing an assertion until it passes is not a fix, and neither is deleting
the platform from the matrix.
