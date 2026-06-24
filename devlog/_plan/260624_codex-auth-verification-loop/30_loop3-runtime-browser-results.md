# 30 - Loop 3 Runtime and Browser Results

Status: planned.

Runtime checks:

```bash
bun run src/cli.ts stop
bun run src/cli.ts ensure
curl -s http://localhost:10100/api/codex-auth/accounts?refresh=1
curl -s http://localhost:10100/api/codex-auth/active
```

Browser checks:

```bash
cli-jaw browser start --agent
cli-jaw browser new-tab http://localhost:10100
cli-jaw browser snapshot --interactive
cli-jaw browser evaluate '<quota column alignment probe>'
```

Results: pending.
