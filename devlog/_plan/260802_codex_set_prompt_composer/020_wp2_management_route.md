# 020 — WP2: `/api/codex-prompt`

New file: `src/server/management/codex-prompt-routes.ts`.
Registered in `src/server/management-api.ts`.
Shape from `sidebar-routes.ts:23-89`; GET/PUT semantics from
`agent-settings-routes.ts:127-178` (`004` §F).

## Endpoints

### `GET /api/codex-prompt`

```jsonc
{
  "configPath": "/Users/x/.codex/config.toml",
  "configExists": true,
  "readable": true,
  "layers": [
    { "id": "permissions", "key": "include_permissions_instructions",
      "configured": null, "effective": true, "default": true }
  ],
  "locked": ["model", "agents-md", "realtime", "plugins", "model-switch"],
  "features": [
    { "id": "personality", "key": "features.personality", "effective": true }
  ],
  "custom": [
    { "id": "a1b2c3", "title": "My house rules", "enabled": true, "body": "..." }
  ],
  "unownedDeveloperInstructions": null,
  "modelInstructionsFile": null
}
```

`locked` is a **server-supplied list**, not a GUI constant. `001` §4 is the
source; putting it on the wire means one place changes when upstream adds an
off-switch. Ask item 9 depends on this list being right.

### `PUT /api/codex-prompt/layer`

`{ "id": "apps", "enabled": false }` → `{ "ok": true, "changed": true, ...snapshot }`

- `id` not in the WP1 allowlist → `400 unknown_layer`.
- `id` in `locked` → `409 layer_not_toggleable`. The GUI never sends this; the
  route refuses it anyway, because a hand-rolled request must not be able to do
  what the UI forbids.
- unreadable config → `409 config_unreadable`.

### `PUT /api/codex-prompt/custom`

`{ "layers": [ {id,title,body,enabled}, ... ] }` — full replacement, order is
composition order.

Validation before any file access:

| Rule | Response |
|---|---|
| `layers` not an array | `400 invalid_body` |
| > 32 layers | `400 too_many_layers` |
| id not `[a-z0-9]{6}` | `400 invalid_layer_id` |
| duplicate id | `400 duplicate_layer_id` |
| title empty, > 80 chars, or contains a newline | `400 invalid_title` |
| body > 64 KiB | `400 body_too_large` |
| composed total > 128 KiB | `400 composed_too_large` |

The body cap is ours, not Codex's — `002` §3 records that Codex validates
nothing beyond readable-and-non-empty. Something has to, and a management API
that writes a file the user's editor also opens is the right place.

## Response echoes the snapshot

Every mutating response returns the freshly re-read snapshot, so the GUI can
`setClientResourceData` with server truth instead of optimistic local state
(`004` §G, `client-resource.ts:464-482`).

## Auth

Nothing extra. `requireManagementAuth` already covers `/api/**`
(`server/index.ts:448-453`) and unsafe methods already require Origin + CSRF
(`management-auth.ts:246-266`). This is a local-config write, not an
account-identity action, so it does **not** need the `agent_consent_required`
treatment that `/api/github/star` carries.

## Privacy

The snapshot carries file paths and user-authored prompt text. It carries no
token, key, or account identifier. Layer bodies are user content the user just
typed into this same GUI — echoing them back is not disclosure. Nothing here is
logged: `privacy:scan` stays green because the route never writes request
bodies to any log sink.

## Tests — `tests/codex-prompt-route.test.ts`

Harness from `sidebar-routes.test.ts:18-58`: a helper building Host-bearing
requests, dispatching `handleManagementAPI`, restoring seams in `finally`. The
WP1 module is injected so **no test touches the real `CODEX_HOME`**.

1. GET returns the snapshot with `locked` populated
2. GET on a missing config → defaults, `configExists: false`
3. PUT layer flips a toggle and echoes the new snapshot
4. PUT layer with an unknown id → 400
5. PUT layer on a locked id → 409, **and the writer is never called**
6. PUT custom round-trips order
7. each validation rule above, one case each
8. unreadable config → 409 on both PUTs
9. hostile Origin rejected (mirrors `management-client-config-route.test.ts:240`)
10. unhandled path returns `null` so the chain continues

Case 5 is the load-bearing one: it proves ask item 9 holds at the API boundary,
not merely in the rendering layer.
