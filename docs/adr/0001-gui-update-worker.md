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

After an update requests a restart, the worker now waits for an identity-checked `/healthz` to
return and remain healthy for a short stability window before marking the job successful. This
keeps `update-job.json` honest on Windows cases where npm leaves the bundled Bun runtime in a bad
state and the restarted proxy dies a few seconds later.

## Consequences

- The GUI request handler stays responsive and does not overwrite its own running module graph.
- Update status survives a proxy restart because it is stored in the opencodex config directory.
- Restart handling can branch between service-managed installs and direct detached proxy starts.
- A completed install can still finish with `status: "failed"` when the replacement proxy never
  becomes healthy or flaps during the stability window; the job log then points the user at
  `ocx start` and the Bun `--allow-scripts` reinstall path.
- The dashboard must poll both the job endpoint and `/healthz` while reconnecting.
