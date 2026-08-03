# WP2 — Grok Build, where a byte snapshot is the right answer

Direction: `006_replan_semantic_restore.md`. Second phase, and the one case in
this unit where the existing byte-snapshot substrate is exactly right.

## Why bytes here and semantics in WP1

`~/.grok/config.toml` is a file opencodex does not otherwise write. Our fence is
the whole integration, and the bytes outside it belong to the user and are
preserved verbatim by `stripGrokConfig` (`001` §Grok). Nothing else of ours
lives in that file, so restoring it whole cannot revert an unrelated opencodex
setting — the failure mode that pushed WP1 to semantics.

That makes this the file-client shape, and the existing
`captureSnapshot`/`appendOperation`/`readSnapshot` substrate handles it with no
widening beyond the client-id union.

## IN

1. `src/integrations/registry.ts` — MODIFY: the native id union and
   `JournalClientId` superset (carried from the retired `010`, which the audits
   never faulted).
2. `src/integrations/journal.ts` — MODIFY: widen the journal/snapshot/maintenance
   surface to `JournalClientId`. Ownership records stay file-client-only
   (audit r2 #10).
3. `src/integrations/store.ts` — MODIFY: same widening, journal side only.
4. `src/integrations/native/grok.ts` — NEW.
5. `src/integrations/native/ownership-preflight.ts` — NEW: the service-home
   check that makes `home_mismatch` reachable (audit r1 #5).
6. `tests/native-grok-toggle.test.ts` — NEW.

OUT: `writer.ts`, `merge.ts`, `serialize.ts`, `ownership.ts` — untouched.

## The client

Grok's pre-state IS its file, so `TState` carries the bytes. The interface is
the same one WP1 established; only the state type differs.

```ts
export interface GrokState {
  /** `null` means the file was absent — restoring that means DELETE. */
  text: string | null;
}

export const grokClient: NativeClient<GrokState> = {
  id: "grok",

  preflight: async (enabled) => {
    if (enabled) return { ok: true };
    /*
     * Shared teardown under a foreign-home service is refused, the same rule
     * `ocx stop` has honored since it started catching ServiceOwnershipError
     * (src/cli/index.ts:464). Nothing on the HTTP side enforced it before, so a
     * route calling stripGrokConfig directly would pull the fence out from
     * under a service running from another CODEX_HOME/OPENCODEX_HOME.
     *
     * Enabling is not gated: writing our own fence is not a shared teardown.
     */
    const owned = assertNativeTeardownOwned();
    if (!owned.ok) return owned;
    return { ok: true };
  },

  capture: async () => ({ text: readTextOrNull(grokConfigPath()) }),

  apply: async (state, ctx) => { ... },   // undo path: write the bytes back
  desired: async (enabled, ctx) => { ... },

  drift: async (state) => {
    const current = readTextOrNull(grokConfigPath());
    return current === state.text
      ? { drifted: false, fields: [] }
      : { drifted: true, fields: [{ key: "config.toml",
          captured: fingerprintOrAbsent(state.text),
          current: fingerprintOrAbsent(current) }] };
  },
};
```

Drift reports a fingerprint, never the content: the file can hold the user's own
`api_key` values outside our fence, and a drift report is not a place to echo
them. `privacy:scan` would catch the alternative, but the reason it must not
happen is the user's, not the linter's.

## The toggle itself delegates

`stripGrokConfig()` for off, `syncGrokConfig(port, config)` for on. Neither is
reimplemented: the guards that matter — the orphaned-marker refusal, alias
reservation, byte-for-byte preservation outside the fence, the one-time
`.bak-opencodex` — all live there and a second copy would rot.

Every `skippedReason` maps to its own refusal (`001` §Grok):

| `skippedReason` | `ok` | Refusal |
|---|---|---|
| `no-grok-home` | true | `not_installed` |
| `orphaned-marker` | **false** | `orphaned_marker` |
| `non-loopback` | true | `non_loopback` |
| none, `ok:false` | false | `write_failed` |

`orphaned_marker` must never become `write_failed`. Nothing failed: a begin
marker without an end marker means we cannot tell where our block stops, so we
decline to guess. Telling the user to retry would be advice that cannot work.

## The snapshot, and when it is discarded

A byte snapshot is captured before the mutation and a journal row is written
after it commits — the existing file-client ordering, unchanged.

Two rules carried from the audits:

- **A refusal writes no journal row and leaves no snapshot** (r1 #3). Preflight
  runs before capture, so the common refusals never produce one at all. For the
  refusals only `mutate` can discover — `orphaned_marker` — the snapshot is
  discarded, and a failed discard is recorded as orphan maintenance rather than
  swallowed (r2 #9): those bytes can hold the user's keys and retention prunes
  from journal rows, so an unreferenced snapshot would never be collected.
- **A partial never reports as a refusal** (r1 #2). `stripGrokConfig` writes the
  file atomically, so a partial is genuinely unlikely here — but the result type
  carries it because the caller must not have to know which clients can produce
  it.

## Acceptance

- [ ] Disable removes only the fenced region; bytes outside it are byte-identical
      afterwards, including a trailing user section and CRLF line endings.
- [ ] Undo restores the captured file exactly, including the fence.
- [ ] A capture of an absent file restores as a DELETE, not an empty file.
- [ ] `orphaned-marker` refuses as `orphaned_marker`, writes nothing, and leaves
      no snapshot behind.
- [ ] `no-grok-home` refuses `not_installed`; the card reads not-installed.
- [ ] A foreign-home install-state fixture makes disable refuse `home_mismatch`
      and write nothing — the branch is reachable, not declared (audit r1 #5).
- [ ] Enabling is NOT gated by the ownership preflight.
- [ ] Drift reports a fingerprint, never file content.
- [ ] Journal rows appear for committed operations only.
- [ ] `bun run typecheck`, the existing Grok tests, and `privacy:scan` green.
