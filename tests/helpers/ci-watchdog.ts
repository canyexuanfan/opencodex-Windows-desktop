/**
 * CI-scaled test watchdogs.
 *
 * Several tests race a real local server round-trip against a short in-test
 * watchdog (`setTimeout(..., reject)`). Locally 1-2 s is generous, but the
 * unsharded GitHub macOS runner runs the whole suite in one pool under heavy
 * CPU contention and these watchdogs were the recurring flake class there
 * (server-auth WS terminal 1 s, provider-option fixture WS 2 s, …). The
 * watchdog exists to bound a genuinely hung test, not to assert latency — so
 * on CI every short watchdog gets a 10 s floor while local behaviour is
 * unchanged. Bun's own per-test timeout stays the outer backstop.
 */
export function watchdogMs(base: number): number {
  return process.env.CI === "true" ? Math.max(base, 10_000) : base;
}
