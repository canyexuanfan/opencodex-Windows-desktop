# Phase 2 - Subcommand Help Consistency

## Objective

Make every `ocx <command> --help` path predictable, side-effect free, and useful enough that a human or agent can choose the next command without reading source.

## Classification

C2/C3 boundary:

- still mostly CLI text and dispatch behavior;
- touches more command paths and nested subcommands;
- needs careful tests to avoid accidentally executing mutating commands when help flags are present.

## Planned Files

### MODIFY `src/cli.ts`

Planned changes:

- Extract subcommand metadata into a small table near the CLI entrypoint.
- Make these equivalent:
  - `ocx <command> --help`
  - `ocx <command> -h`
  - `ocx help <command>`
- Add richer help for:
  - `init`
  - `start`
  - `stop`
  - `restore` / `eject`
  - `status`
  - `sync`
  - `login`
  - `logout`
  - `service`
  - `codex-shim`
  - `update`
  - `recover-history`
- Nested help:
  - `ocx service --help`
  - `ocx service status --help`
  - `ocx codex-shim --help`
  - `ocx codex-shim status --help`
- Keep actual command behavior unchanged.

### MODIFY `tests/cli-help.test.ts`

Planned changes:

- Add regression tests for help-before-action on representative mutating commands:
  - `ocx stop --help`
  - `ocx uninstall --help`
  - `ocx service uninstall --help`
  - `ocx codex-shim uninstall --help`
- Add assertions that these do not write or remove Codex/opencodex files.

### MODIFY `docs-site/src/content/docs/reference/cli.md`

Planned changes:

- Document `ocx help <command>` and nested help conventions.
- Add a compact command decision table:
  - setup
  - start/stop
  - status/diagnose
  - auth
  - service/shim
  - recovery/uninstall

## Acceptance Criteria

- Every documented help path exits 0.
- Help flags on mutating commands do not mutate local state.
- Unknown nested subcommands show exact usage and exit 1.
- Existing tests remain green.

## Verification

```bash
bun test tests/cli-help.test.ts tests/service.test.ts
bun run typecheck
```

## Suggested Commit

```text
fix(cli): make subcommand help side-effect free
```

