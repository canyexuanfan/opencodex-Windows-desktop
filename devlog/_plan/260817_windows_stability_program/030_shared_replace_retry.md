# 030 — Make the Windows replace-with-retry a shared primitive (F4)

**Depends on:** nothing structurally, but sequence it after 020 so the service
and update paths are settled before touching the write path.

## Change

Export the retry loop currently inlined at `src/config.ts:102-123` as a
filesystem primitive both sync and async publishers call. It already has the
right shape: retry only on `win32` and only for `EBUSY`/`EPERM`/`EACCES`,
never masking a real error. The async twin at `src/config.ts:287-299` folds in
with it.

Convert the raw `renameSync` publishers to the primitive:

- `src/codex/prompt-journal.ts` — the journal carries full `config.toml` bytes;
  a failure here is what breaks journal restore.
- `src/lib/config-ownership.ts` — the uninstall ownership manifest.

Then sweep `src/` for remaining `renameSync` calls that publish a durable file
and either convert them or leave a comment saying why the file is transient.

**Do not change the retry envelope in this phase.** It stays at two retries /
75ms. Widening it without evidence is how a 75ms hiccup becomes a 5s stall.

## Verify

```powershell
bun test tests/config.test.ts
bun test tests/codex-journal.test.ts
```

The existing `AtomicRenameIO` injection point (`src/config.ts:105-109`) already
makes this testable without a real sharing violation: inject a `rename` that
throws `EBUSY` twice then succeeds, and assert the publisher completes.

## Risk

Low-medium. The primitive is behavior-preserving for callers that already used
it. The new callers gain retries they did not have, which can only convert a
throw into a success. Watch for any caller that *depends* on `renameSync`
throwing promptly to detect a lock.
