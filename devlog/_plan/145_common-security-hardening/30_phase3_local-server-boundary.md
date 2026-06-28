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

## Diff-level plan

MODIFY `tests/server-auth.test.ts`

- Add an `OPTIONS` preflight regression test:
  - loopback/default config rejects non-loopback `Origin` with 403.
  - loopback/default config accepts matching loopback `Origin` with 204.
- Add a WebSocket upgrade regression test for non-loopback bindings:
  - valid `X-OpenCodex-API-Key` is not enough when `Origin` is hostile.
  - response is 403 with `origin_rejected` / cross-origin rejection shape.
- Reuse existing `startServer`, `saveConfig`, and `config()` test helpers.

MODIFY `src/server.ts` only if the new tests expose an actual boundary gap.

MODIFY `devlog/_plan/145_common-security-hardening/30_phase3_local-server-boundary.md`

- Record whether this phase was test-only or required a server patch.
- Record verification commands and commit.

Out of scope:

- Do not change Kiro adapter parity files.
- Do not broaden CORS to support arbitrary browser apps.
- Do not introduce a new auth scheme; use the existing local API auth behavior.
