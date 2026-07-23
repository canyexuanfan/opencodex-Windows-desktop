# Phase 3 — transport hardening: session errors, idempotent cleanup, discovery retry

Owns RC3 (000_plan.md). Three bounded changes; the committed-turn no-replay
guard (`transport-retry.ts`) is explicitly OUT of scope.

## 3a. Session-level error listener (live turn transport)

### MODIFY `src/adapters/cursor/live-transport.ts`

After the `connect` listener (`:601-604`), register an error handler that routes
through the SAME terminal path as stream errors, guarded for idempotence:

```ts
    this.session.on("error", err => {
      const realErr = err instanceof Error ? err : new Error(String(err));
      debugProviderDiagnostic("cursor", "session-error", {
        code: String((realErr as { code?: unknown }).code ?? ""),
        message: redactCursorForLog(realErr.message),
        elapsedMs: Date.now() - this.turnStartedAt,
      });
      failAndClear(realErr);
    });
```

Placement detail: `failAndClear` is declared later in the current function body
(`:620`), so either (a) move the `session.on("error", ...)` registration below
the `failAndClear` declaration (still before any await), or (b) hoist
`failAndClear` above both registrations. Prefer (a): smaller diff, ordering of
listener registration vs. first turn bytes is unaffected because everything in
this function runs synchronously before the request flushes.

Idempotence: `fail()`/`finish()` are already single-shot (verify the existing
settled guard in this class at B time; if `fail` is not guarded, add a
`this.settled` boolean so stream-error + session-error double-fire cannot emit
two terminal callbacks).

## 3b. Forceful idempotent first-frame-timeout cleanup

### MODIFY `src/adapters/cursor/live-transport.ts` (`:639-646`)

Before:
```ts
      try { stream.close(); } catch { /* already closing */ }
      try { session.close(); } catch { /* already closing */ }
```
After:
```ts
      try { stream.close(); } catch { /* already closing */ }
      try { session.close(); } catch { /* already closing */ }
      // close() waits for in-flight frames; a dead socket can ignore it. Destroy
      // shortly after so a stalled TLS session cannot linger past the timeout.
      setTimeout(() => {
        try { if (!stream.destroyed) stream.destroy(); } catch { /* gone */ }
        try { if (!session.destroyed) session.destroy(); } catch { /* gone */ }
      }, 1_000).unref?.();
```

## 3c. Bounded discovery retry with a fresh session

### MODIFY `src/adapters/cursor/live-models.ts`

Wrap the existing single-attempt promise body in a private `attemptOnce()` and
retry ONCE for transient pre-response failures only:

```ts
const RETRYABLE_DISCOVERY_ERRORS = new Set(["timeout", "http"]);

export async function fetchCursorUsableModels(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  const first = await fetchCursorUsableModelsOnce(opts);
  if (first.ok || !RETRYABLE_DISCOVERY_ERRORS.has(first.error)) return first;
  // One bounded retry with a brand-new HTTP/2 session: transient dial/TLS/timeout
  // failures are common on wake; auth/decode/empty results are deterministic.
  await new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 250)));
  return fetchCursorUsableModelsOnce(opts);
}
```

`fetchCursorUsableModelsOnce` = current function body renamed (each call already
creates its own `http2.connect` session — no pooling added). Non-retryable:
`auth`, `decode`, `empty` (deterministic), and any completed non-2xx mapped to
those categories.

Callers (`discovery.ts` / catalog refresh) are unchanged: same signature, same
result union; worst-case added latency ≈ timeoutMs + ~500ms jitter, acceptable
for a background catalog path.

## Accept criteria + activation scenarios (C-ACTIVATION-GROUNDING-01)

1. Session `error` event (no stream error) → exactly one terminal failure emitted;
   test drives a fake session emitting `error` and counts terminal callbacks.
2. First-frame timeout on a stream/session whose `close()` is a no-op → both get
   `destroy()`ed within ~1s; test uses stubs with `destroyed=false` and asserts
   `destroy` was called (timer faked or shortened).
3. Discovery: first attempt returns `{ok:false,error:"timeout"}` → second attempt
   runs with a NEW session and its success is returned; first attempt
   `{ok:false,error:"auth"}` → NO retry (call count 1).

## Tests

- `tests/cursor-live-transport.test.ts` — 3a, 3b (the suite already stubs
  http2 internals; extend its fake session/stream helpers).
- `tests/cursor-hardening.test.ts` — 3c with an injected `fetch...Once` seam or
  http2 stub, matching how the suite currently fakes discovery.

## Verification

```
bun run typecheck
bun test tests/cursor-live-transport.test.ts tests/cursor-hardening.test.ts
bun run test   # full suite before D
```
