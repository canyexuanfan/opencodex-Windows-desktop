# 070 — PR #255: Fix provider JSON editor save flow

- **Author:** rrmlima
- **Branch:** agent/fix-provider-json-save → dev
- **Status:** Draft → needs undraft before merge
- **CI:** enforce-target pass (3x)
- **Decision:** MERGE (undraft first)
- **Risk:** Medium (GUI + backend save flow change)

## Changes

1. `gui/src/pages/Providers.tsx`:
   - Replaces single `PUT /api/config` with per-provider `POST /api/providers` loop.
   - Deletes providers absent from draft via `DELETE /api/providers?name=...`.
   - Validates parsed JSON structure before saving.
   - Blocks port/hostname/websockets changes from JSON editor.
   - Handles `codexAutoStart` via `PUT /api/settings`.
2. `src/server/management-api.ts`:
   - Preserves `apiKey`, `apiKeyPool`, `headers`, `googleMode`, `modelMaxInputTokens` when not provided in update.
   - Prevents credential loss from browser round-trip of masked values.

## Security Review

- This FIXES a credential safety issue: previously, saving from the GUI JSON editor could erase API keys that were masked in the browser.
- The preservation list (`apiKey`, `apiKeyPool`, `headers`, etc.) covers known sensitive fields.
