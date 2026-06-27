# opencodex dashboard

This is the Vite/React dashboard used by `ocx gui` in packaged installs.

## Source checkout development

Run the proxy and dashboard as two separate dev processes:

```bash
# terminal 1, repo root
bun run dev:proxy

# terminal 2, repo root
bun run dev:gui
```

The root proxy dev server exposes API endpoints such as `/healthz`, `/v1/responses`,
and `/api/*`. It serves `GET /` only when a packaged dashboard build exists at
`gui/dist`, so a fresh clone should use the Vite dev server while editing the UI.

## Build

From the repo root:

```bash
bun run build:gui
```

That command installs/builds this dashboard and copies the production assets into
the package layout used by `ocx gui`.
