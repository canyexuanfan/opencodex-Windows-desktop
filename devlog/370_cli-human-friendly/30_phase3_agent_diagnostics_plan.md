# Phase 3 - Agent-Friendly Diagnostics Contract

## Objective

Give agents and scripts a stable read-only diagnostics contract so they do not need to scrape human text from `ocx status`.

## Classification

C3 public CLI/API contract:

- introduces machine-readable output;
- must avoid secrets;
- impacts dashboard/agent workflows and docs.

## Planned Files

### MODIFY `src/cli.ts`

Planned changes:

- Add `ocx status --json`.
- Keep existing human `ocx status` output unchanged unless Phase 1/2 help text already changed it.
- JSON should include only safe fields:

```json
{
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "codexAutostart": true,
  "service": {
    "summary": "..."
  },
  "codexShim": {
    "summary": "..."
  }
}
```

- Avoid tokens, provider API keys, Authorization headers, raw emails, and request content.

### MODIFY `tests/cli-help.test.ts` or ADD `tests/cli-status-json.test.ts`

Planned changes:

- Assert `ocx status --json` parses as JSON.
- Assert no known secret-looking fields are present.
- Assert it does not start the proxy.
- Assert human status still includes existing diagnostics.

### MODIFY `docs-site/src/content/docs/reference/cli.md`

Planned changes:

- Add `status --json` schema and example.
- Explain that JSON is intended for agents/scripts and may grow by additive fields only.

### OPTIONAL MODIFY `structure/01_runtime.md`

Only if the schema is implemented:

- Add `status --json` to CLI entrypoint responsibilities.

## Acceptance Criteria

- `ocx status --json` exits 0 with valid JSON.
- JSON output is read-only and token-safe.
- Existing `ocx status` human output remains usable.
- Tests and typecheck pass.

## Verification

```bash
bun test tests/cli-help.test.ts tests/cli-status-json.test.ts
bun run typecheck
bun run privacy:scan
```

## Suggested Commit

```text
feat(cli): add json status diagnostics
```

