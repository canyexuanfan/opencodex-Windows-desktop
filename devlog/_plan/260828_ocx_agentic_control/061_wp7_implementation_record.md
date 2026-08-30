# 061 — wp7 implementation record: residual GUI-parity closure

Branch: `codex/ocx-gui-parity`, stacked on `codex/ocx-account-attribution`.
Plan: `060_phase_gui_parity.md`, whose stated method is to let the measurement name the gaps
rather than trusting a pre-written table. Doing that changed the answer substantially.

## What the measurement said

Of 207 declared management routes, 33 are exempt and 164 have no capability entry. But a
capability entry is bookkeeping; the parity question is whether the CLI can *reach* the route at
all. Checking each uncovered path against `src/cli/` with an exact-literal search:

| | count |
|---|---|
| declared routes | 207 |
| exempt | 33 |
| no capability entry | 164 |
| **no CLI reference at all** | **26** |

The remaining 138 are reachable today and simply undeclared — a wp3 bookkeeping debt, not a
GUI-only capability. Conflating the two would have turned this phase into 164 speculative verbs.

Two heuristics were tried and both were wrong before the exact search settled it: a bare substring
match called `POST /api/storage/cleanup` reachable (it is not — no CLI file mentions it), and a
strict literal match called the `codex-logs` routes unreachable (they are reachable, built by
interpolation at `observe.ts:201`). Both were corrected by per-path `rg`, and the plan's own table
was wrong on the same two points.

## Verbs added

| Verb | Routes |
|---|---|
| `ocx storage report` | `GET /api/storage` |
| `ocx storage cleanup --percent N [--mode] [--yes]` | `POST /api/storage/cleanup/preview`, `POST /api/storage/cleanup` |
| `ocx storage trash [list]`, `trash restore <id> --yes` | `GET /api/storage/trash`, `POST /api/storage/trash/restore` |
| `ocx storage policy [show|set|run --yes]` | `GET|PUT /api/storage/cleanup-policy`, `POST …/run` |
| `ocx inspect config|catalog|routing-analytics|key-providers|windows-tray` | the matching GETs |
| `ocx inspect pacing [--name]` | `GET /api/provider-request-pacing` |
| `ocx inspect client-config --client <id>` | `GET /api/client-config` |
| `ocx inspect codex-prompt [--text]` | `GET /api/codex-prompt`, `/text` |
| `ocx inspect star` | `GET /api/github/star` — **read only, permanently** |
| `ocx integration native [list|<client> on|off]` | `GET /api/native-integrations`, 4 per-client PUTs |
| `ocx agent request-user-input [on|off]` | `GET|PUT …/features/default-mode-request-user-input` |

## Destructive verbs

Three of these delete or move operator data, and all three follow the same rule: **no mutation
without `--yes`, and no interactive prompt.** A prompt an agent can answer is not a safety
boundary, so the flag is the boundary.

`cleanup` is the interesting one. It previews in *both* paths, and not out of politeness: the
mutating route requires the digest the preview returns and rejects a stale one with 409
`stale_preview`. So the confirmed path cannot skip the preview, which means `--yes` and bare
invocation agree about what is being authorized.

`inspect star` is the deliberate opposite. `POST /api/github/star` spends the operator's GitHub
identity, and the server requires a real dashboard session for it precisely so an agent cannot
answer that question on their behalf. No flag can carry that consent, so the verb reads status and
says plainly that starring is not available from the CLI, rather than offering a `--yes` that
would be a lie.

## The dead route is gone

`GET /api/storage` had two handlers. `handleStorageLogGuardRoutes` runs first
(`management-api.ts:221`) and answers every such request, so the copy at
`logs-usage-routes.ts:346` was unreachable — declared in the registry with a `dead` exemption
whose own note said to delete rather than expose it.

It is deleted, along with its two now-unused imports. The registry declaration is gone, and the
reconciliation test was rewritten: it now asserts `/api/storage` has exactly ONE declaration
pointing at the live module, and that **no `dead` exemption survives anywhere** — that vocabulary
exists for routes awaiting deletion, so a lingering one means the deletion never happened. Driving
the deletion first made the old test fail, which is how I know it was checking something real.

## Two regressions caught while building

**`ocx storage --json` broke.** `storage` was an alias of `observe storage`; giving it subcommands
made a leading flag parse as a subcommand name, so the previously-working invocation errored with
`unknown storage command --json`. Fixed by only treating a non-flag first argument as a
subcommand, and pinned by a test that runs both `[]` and `["--json"]`.

**`integration native list` printed `clients: 4 item(s)`.** The shared depth-1 flattener renders
an array as a count, so every per-client column was in the payload and discarded before the
terminal — the same defect class wp4 fixed for the account tables. It now renders CLIENT / STATE /
INSTALLED / DESIRED / CONFIG, and names a blocked disable instead of dropping it.

`integration` and `inspect` also already existed as names. `native` was folded into the existing
`integration` dispatcher rather than shadowing it, and the duplicate-name gate in
`tests/cli-registry.test.ts` is what caught the collision.

## Red probes

| Probe | Result |
|---|---|
| `cleanup` ignores `--yes` and always mutates | 1 fail — the no-mutating-request assertion |
| `cleanup --yes` omits the preview digest | 1 fail |
| `policy set` always sends `enabled` | 2 fail — implicit-disable and empty-write |
| the dead `/api/storage` handler deleted | the old registry test failed until updated |

## Verification

```
bun test tests/cli-storage-inspect.test.ts tests/cli-capabilities.test.ts \
  tests/cli-headless-parity.test.ts tests/cli-registry.test.ts tests/cli-dispatch.test.ts \
  tests/management-route-registry.test.ts tests/management-api-logs-metrics.test.ts \
  tests/storage-log-guard-routes.test.ts
→ 107 pass, 0 fail across 7 files

./node_modules/.bin/tsc --noEmit → clean
bun run privacy:scan            → passed
```

Live, against the running proxy:

```
storage --json                      → real report (45.0 GB, 450057 files)
storage cleanup --percent 1         → names the exact file, "Nothing was deleted", exit 0
storage policy run                  → refuses, exit 2
storage trash restore some-id       → refuses, exit 2
storage cleanup (no --percent)      → refuses, exit 2
inspect star                        → starred + the cannot-star sentence
inspect pacing --name xai           → provider: xai, enabled: false
inspect client-config --client codex → 400 naming all 11 valid ids
integration native list             → 4 clients with real state columns
agent request-user-input            → enabled: true
```

The `client-config` result is worth keeping: `codex` is not a valid export client id, and the
route answered with the full accepted list. That is why the CLI does not duplicate the list
locally — the server's error is more useful than a local copy that can drift.

## Deferred, still owned

The ~138 reachable-but-undeclared routes are capability-table debt, not parity gaps. Declaring all
of them is mechanical and belongs with the wp3 registry work rather than here; the ones this phase
touched are declared. The mutating `/api/lab` routes keep their `deferred-verb` exemptions naming
this phase — they remain owed, and the exemption vocabulary keeps them visible rather than
silently accepted.

## Subagent dispatch

Sol-tier spawns continued to fail with 429, so the route census, the two corrected heuristics, and
every probe were done directly. Recorded rather than implied.

