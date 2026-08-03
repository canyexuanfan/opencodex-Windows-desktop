# WP1 — Claude Code, the one with no external file

Direction: `006_replan_semantic_restore.md`. This is the first phase because it
is the smallest complete instance of the pre-state pattern: if the shape does
not work here, it will not work for the harder three.

## IN

1. `src/integrations/native/pre-state.ts` — NEW: the pre-state contract.
2. `src/integrations/native/claude-code.ts` — NEW: the Claude Code client.
3. `tests/native-claude-code-toggle.test.ts` — NEW.

OUT: everything under `src/integrations/` that serves the six file clients;
`/api/claude-code` and its settings page, which keep owning the detailed
configuration. This phase adds a toggle, not a second settings surface.

## What the integration actually is

`config.claudeCode.enabled`. Read at six call sites, and `false` makes
`/v1/messages` answer 403, stops agent injection, stops system-env injection,
and makes `ocx claude` refuse (`001` §Claude Code).

No file outside opencodex changes. **But the toggle does write our own
`config.json`**, so this is "no external client file", not "no disk write" —
the distinction round-1 #12 made me correct.

## The contract

```ts
// src/integrations/native/pre-state.ts — NEW

/**
 * What a client must be able to say about itself so a toggle can be undone.
 *
 * Deliberately NOT a byte snapshot. Three audit rounds established that for
 * these clients the bytes are the wrong unit: their state lives in a config
 * file shared with every other setting, in another application's registry, and
 * behind paths that can move between capture and restore. A pre-state holds
 * VALUES and re-applies them through the same path that established them, so
 * nothing persisted ever becomes a write destination and no unrelated setting
 * is caught in the blast radius (`006`).
 */
export interface NativeClient<TState> {
  id: NativeIntegrationClientId;

  /** Non-mutating gate. Every knowable refusal belongs here. */
  preflight(enabled: boolean, ctx: NativeContext):
    Promise<{ ok: true } | { ok: false; reason: NativeRefusalReason; message: string }>;

  /** The smallest description from which this client can be re-established. */
  capture(ctx: NativeContext): Promise<TState>;

  /**
   * Apply a state. Called for the toggle AND for the undo — one code path, so
   * undo can never drift from the operation it reverses.
   */
  apply(state: TState, ctx: NativeContext): Promise<NativeApplyResult>;

  /** The state that means "on", for the enable direction. */
  desired(enabled: boolean, ctx: NativeContext): Promise<TState>;

  /**
   * Has anything we own changed since `state` was captured? Answered per FIELD,
   * not per file, so an unrelated edit to the same config never reads as drift
   * (audit r3 #4, #5).
   */
  drift(state: TState, ctx: NativeContext): Promise<DriftReport>;
}

export interface DriftReport {
  drifted: boolean;
  /** Named fields whose current value differs from the captured one. */
  fields: readonly { key: string; captured: string; current: string }[];
}

export type NativeApplyResult =
  | { status: "changed"; message: string }
  | { status: "unchanged"; message: string }
  | { status: "refused"; reason: NativeRefusalReason; message: string }
  /**
   * Some state changed and could not be put back. Carries what is inconsistent
   * so the caller can surface it — the round-1 #2 rule, preserved because it
   * outlived the substrate it was written for.
   */
  | { status: "partial"; message: string; residual: readonly string[] };

export type NativeRefusalReason =
  | "not_installed" | "orphaned_marker" | "home_mismatch" | "foreign_owner"
  | "non_loopback" | "no_safe_desktop_fallback" | "unowned_profile"
  | "legacy_profile_unverified" | "unsafe" | "write_failed";
```

One union of refusal reasons, complete from the start — round 3 #6 failed the
previous draft for using values its own type did not declare.

## Claude Code

```ts
// src/integrations/native/claude-code.ts — NEW

export interface ClaudeCodeState { enabled: boolean }

export const claudeCodeClient: NativeClient<ClaudeCodeState> = {
  id: "claude",
  // Nothing to gate: no external install to detect, no shared teardown, no
  // ownership question. Stating that explicitly is the point — a preflight
  // that returns ok is a decision, not an omission.
  preflight: async () => ({ ok: true }),

  capture: async ctx => ({ enabled: ctx.config.claudeCode?.enabled !== false }),
  desired: async enabled => ({ enabled }),

  apply: async (state, ctx) => {
    if ((ctx.config.claudeCode?.enabled !== false) === state.enabled) {
      return { status: "unchanged", message: state.enabled ? "already on" : "already off" };
    }
    /*
     * `saveConfigPreservingClaudeCode` merges the claudeCode subtree against
     * what is on disk rather than replacing the file, so a concurrent edit to
     * another section survives. That is exactly why undo re-applies a FIELD
     * instead of restoring captured bytes.
     *
     * Its documented residual: only `claudeCode` is reconciled — a hand edit to
     * `providers` is still clobbered (src/config.ts:2130-2136). We inherit that
     * limit rather than pretending this phase fixes it.
     */
    ctx.config.claudeCode = { ...(ctx.config.claudeCode ?? {}), enabled: state.enabled };
    saveConfigPreservingClaudeCode(ctx.config);
    return { status: "changed",
      message: state.enabled ? "Claude inbound enabled" : "Claude inbound disabled" };
  },

  drift: async (state, ctx) => {
    const current = ctx.config.claudeCode?.enabled !== false;
    return current === state.enabled
      ? { drifted: false, fields: [] }
      : { drifted: true, fields: [{ key: "claudeCode.enabled",
          captured: String(state.enabled), current: String(current) }] };
  },
};
```

## Undo

The pre-state is one boolean, so undo is `apply(captured)`. Idempotent, which
is what removes the prepared-crash ambiguity round 3 #3 raised for the byte
design: re-applying a state does not need to know whether the original mutation
ran.

Drift here is not an error. If the user flipped the switch again after the
operation, `drift` reports it and the caller decides — the undo would be
overwriting a deliberate later choice, which is the user's to confirm.

## Acceptance

- [ ] `capture` on a config with no `claudeCode` key returns `enabled: true` —
      absent means on, matching the six existing read sites.
- [ ] `apply({enabled:false})` sets the flag and `/v1/messages` answers 403.
- [ ] `apply` of the current value returns `unchanged` and writes nothing.
- [ ] Undo restores the captured value through `apply`, not a file write.
- [ ] A concurrent edit to an unrelated config section survives the toggle —
      the audit r3 #4 case, asserted rather than assumed.
- [ ] `drift` reports the field by name when the flag changed since capture.
- [ ] `bun run typecheck` clean; the existing Claude tests stay green.
