# 30 — Phase 3: Local HTTP/WS boundary

Purpose: verify and harden local server exposure for `/api/*`, `/v1/models`,
`/v1/responses`, and WebSocket upgrades.

Planned surfaces:

- `src/server.ts`
- `src/ws-bridge.ts` only if server tests reveal a WebSocket boundary gap.
- `tests/server-auth.test.ts`
- `tests/ws-endpoint.test.ts` if needed.

Checks:

- Non-loopback binding requires configured API auth for API/model/response
  surfaces.
- Non-local `Origin` is rejected for management and WebSocket paths.
- CORS does not use wildcard credentials behavior.
- WebSocket upgrade inherits the same local-origin and auth boundary.

Verification:

- Focused server-auth tests.
- Typecheck.
