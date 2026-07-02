# ADR 0001: GUI self-update runs through a worker job

## Status

Accepted

## Context

The dashboard needs buttons for `ocx sync` and opencodex self-update. `ocx sync` is safe to run in
the proxy process because it refreshes Codex config/catalog state. `ocx update` is different: npm
installs may replace the package files currently serving the GUI, and the existing CLI update path
can print to inherited stdio and exit the process.

## Decision

GUI self-update is not executed directly in the request handler. The dashboard calls management
API endpoints that create an update job in `OPENCODEX_HOME/update-job.json`. The proxy starts a
detached hidden CLI worker, and the worker performs the install command and optional restart.

For npm installs, the worker runs the Node launcher path (`node bin/ocx.mjs update --tag <tag>`) so
the existing npm self-update guard is reused. For Bun global installs, it runs the existing Bun
global update command. Source checkouts remain manual-only and show `git pull && bun install &&
bun run build:gui`.

## Consequences

- The GUI request handler stays responsive and does not overwrite its own running module graph.
- Update status survives a proxy restart because it is stored in the opencodex config directory.
- Restart handling can branch between service-managed installs and direct detached proxy starts.
- The dashboard must poll both the job endpoint and `/healthz` while reconnecting.
