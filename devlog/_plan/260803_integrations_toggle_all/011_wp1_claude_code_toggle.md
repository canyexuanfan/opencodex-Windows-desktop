# WP1 — Claude Code, the one with no external file

> **Rev 2** after audit round 4 (`007_audit_synthesis_r4.md`). The generic
> `NativeClient<TState>` abstraction is GONE. Four audits established that a
> durable pre-state schema is real work that only Codex and Desktop need, and
> those two have moved to their own unit. What is left here is what Claude Code
> actually requires, which is very little.

## What this toggle actually is

`config.claudeCode.enabled`. One boolean, read at six call sites; `false` makes
`/v1/messages` answer 403 and stops agent and system-env injection
(`001` §Claude Code).

**Undo is flipping it back.** No journal row, no snapshot, no captured
pre-state, no restore route. The Rollback Centre exists for operations that
move bytes in someone else's file; this one changes a field in ours, and the
user reverses it with the same switch.

That is the round-4 lesson applied: I spent three revisions building a
transactional store around an operation that needs none of it.

## IN

1. `src/server/management/native-integration-routes.ts` — NEW: a small module
   owning `GET /api/native-integrations` and
   `PUT /api/native-integrations/claude`.
2. `src/server/management-api.ts` — MODIFY: mount it.
3. `tests/native-claude-code-toggle.test.ts` — NEW.

OUT: `src/integrations/**` entirely — no journal, no snapshot, no store, no id
widening. `/api/claude-code` keeps owning the detailed settings; this adds a
toggle, not a second settings surface.

## The route

```ts
// PUT /api/native-integrations/claude   { enabled: boolean }

if (typeof body.enabled !== "boolean") {
  return jsonResponse({ error: "enabled must be a boolean" }, 400);
}
const current = config.claudeCode?.enabled !== false;
if (current === body.enabled) {
  return jsonResponse({ ok: true, clientId: "claude", changed: false,
    state: body.enabled ? "current" : "absent", message: "no change" });
}
config.claudeCode = { ...(config.claudeCode ?? {}), enabled: body.enabled };
saveConfigPreservingClaudeCode(config);
return jsonResponse({ ok: true, clientId: "claude", changed: true,
  state: body.enabled ? "current" : "absent", message: ... });
```

This is the same write `PUT /api/claude-code` already performs for the switch on
the Claude tab (`agent-settings-routes.ts:939-941`), so the two controls cannot
disagree about what "off" means.

## The config-isolation claim, corrected

Rev 1 asserted that an unrelated config edit survives the toggle. **That was
false**, and its own source said so — `saveConfigPreservingClaudeCode`'s
docstring (`src/config.ts:2132-2135`):

> Scope residual: only `claudeCode` is reconciled. A hand edit to `providers` is
> still clobbered — recorded and asserted in tests so it cannot drift into an
> assumed guarantee.

The honest statement: this toggle inherits exactly the concurrency behavior every
other `claudeCode` writer already has. It is not better and not worse, and this
unit does not fix it. A field-scoped config writer would — and belongs in the
unit that needs it for Desktop's four fields, not here.

`config:ocx` in the coordinator (`030`) still serializes this against other
integration-owned config writes, which is what stops two toggles racing each
other.

## Acceptance

- [ ] A config with no `claudeCode` key reads as ON — absent means enabled,
      matching the six existing read sites.
- [ ] `PUT {enabled:false}` sets the flag and `/v1/messages` answers 403.
- [ ] `PUT` of the current value returns `changed: false` and writes nothing.
- [ ] The card switch and the Claude tab switch agree after either is used.
- [ ] No journal row and no snapshot are written by this toggle.
- [ ] `bun run typecheck` clean; the existing Claude tests stay green.
