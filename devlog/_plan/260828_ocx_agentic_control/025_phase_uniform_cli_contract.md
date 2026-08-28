# 025 — wp3b: uniform CLI contract (exit codes and `--json`)

Branch: `codex/ocx-uniform-contract` off `codex/ocx-capability-registry`.

Split out of wp3 (see `020` §020.5). It consumes wp3's capability table: the tests
here read each capability's declared `json` mode, so this phase cannot precede it.

## 025.1 — commands that cannot gate a script

`doctor` and `sync-cache` always return 0 (002). A diagnostic that cannot fail is
not usable in a pipeline, which is the whole point of an agentic surface.

- `src/cli/doctor.ts` — return non-zero when any check fails. `010.5` added the
  admin/data-plane collision check, which is exactly the case an operator needs to
  gate on.
- `sync-cache` — return non-zero on a failed cache write.

**This is a breaking change for pipelines** that run `ocx doctor` and ignore the
result. Call it out in the PR description and the docs-site changelog. The
alternative — a diagnostic command that always claims success — is worse.

## 025.2 — `--json` accepted in any argv position

Two commands parse it specially and both are wrong for scripting:

- `status` accepts `--json` **only as a lone argument** (`index.ts:833`:
  `statusArgs.length === 1 && statusArgs[0] === "--json"`), so `ocx status --json --verbose`
  silently prints human output.
- `restore` matches it positionally at `args[1]`, so `ocx restore back --json`
  **ignores the flag entirely**.

Convert both to the order-independent `takeFlag` used everywhere else.

## 025.3 — `--json` where it is missing

`doctor`, `login`, `logout`, `sync`, `sync-cache`, `debug` have no `--json` at all
(002). Each gets one, emitting the same data its human output describes.

`debug` is the interesting one: it builds its usage text by string interpolation
(`debug.ts:184`) and prints raw log rows. Its JSON mode should emit the rows as an
array rather than a formatted blob, so an agent can filter without parsing text.

## 025.4 — declare and enforce the contract

Every capability in wp3's table declares a `json` mode. Add a test asserting that
each capability with `json !== "none"` accepts `--json` in **any** argv position and
emits parseable JSON on stdout. That is the assertion that stops the next drift:
today's inconsistency exists because nothing ever checked.

Also assert the exit-code vocabulary is uniform: 0 ok, 2 usage, 4 not found,
5 conflict, 64 bad args (`ready` only), 1 otherwise — including for the `account`
family after `010.3` gave it the 404/409 mapping.

## Tests

| File | Assertion |
|---|---|
| `tests/cli-json-contract.test.ts` (NEW) | every `json`-declaring capability accepts `--json` in any position and emits valid JSON |
| `tests/cli-status-json.test.ts` | `ocx status --json` works alongside other flags |
| `tests/doctor.test.ts` | non-zero exit on a failing check |
| `tests/cli-dispatch.test.ts` | `restore back --json` honors the flag |

## Accept criteria

1. `doctor` and `sync-cache` exit non-zero on failure, and the change is documented
   as breaking.
2. `--json` works in any argv position for every capability that declares it.
3. Six previously JSON-less commands emit JSON.
4. A test enforces the contract rather than a convention.

