# 010 — WP1: Runtime stream-capability gate + persisted stream-mode setting

Depends: none. Consumes: 001 §4-§5.

## MODIFY / NEW map

### NEW src/lib/bun-stream-caps.ts

Runtime capability gate for the eager relay. Pure, version-injectable.

```ts
/**
 * Bun runtime stream-capability gate for the Windows SSE passthrough path.
 *
 * The eager bounded relay (relay-eager.ts) uses a JS async producer loop — the
 * exact shape of the Bun#32111 use-after-free (fixed by PR #32120, merged
 * 2026-06-21). No RELEASED Bun version is proven to carry that fix yet, so the
 * min-fixed constant is null: every runtime is "known-bad" until a bundle-bump
 * commit sets it. Config `streamMode` can force either path.
 */

/** Bump in the SAME commit that bumps package.json's bundled Bun to a version
 *  verified to include Bun PR #32120. null = no released version is known-fixed. */
export const MIN_FIXED_BUN_VERSION: string | null = null;

export type StreamMode = "auto" | "legacy-tee" | "eager-relay";

export function parseBunVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareBunVersions(a: string, b: string): number | null {
  const pa = parseBunVersion(a); const pb = parseBunVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) { if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!; }
  return 0;
}

/** True when `version` is proven to carry the #32120 fix. Conservative: unknown → false. */
export function bunHasAsyncPullCancelFix(version: string, minFixed: string | null = MIN_FIXED_BUN_VERSION): boolean {
  if (!minFixed) return false;
  const cmp = compareBunVersions(version, minFixed);
  return cmp !== null && cmp >= 0;
}

export type EagerRelayDecision = {
  useEagerRelay: boolean;
  reason: "config-legacy" | "config-eager" | "auto-fixed-runtime" | "auto-known-bad";
};

/**
 * Decide the win32 SSE client-path shape. platform/version injectable for tests.
 * Non-win32 callers never consult this (their default path is unchanged).
 */
export function decideEagerRelay(
  mode: StreamMode,
  version: string = Bun.version,
  minFixed: string | null = MIN_FIXED_BUN_VERSION,
): EagerRelayDecision {
  if (mode === "legacy-tee") return { useEagerRelay: false, reason: "config-legacy" };
  if (mode === "eager-relay") return { useEagerRelay: true, reason: "config-eager" };
  return bunHasAsyncPullCancelFix(version, minFixed)
    ? { useEagerRelay: true, reason: "auto-fixed-runtime" }
    : { useEagerRelay: false, reason: "auto-known-bad" };
}
```

### MODIFY src/types.ts (OcxConfig, after `fastMode?: boolean;` ~:447)

```ts
  /**
   * Windows SSE passthrough stream shape (#314 mitigation).
   * "auto" (default): eager bounded relay only on runtimes proven to carry the
   * Bun#32111 fix (none today → legacy tee). "eager-relay": force the new relay
   * (accepts #32111 crash risk on 1.3.14). "legacy-tee": pin the tee path.
   * Persisted in config.json because Windows services do not inherit shell env.
   */
  streamMode?: "auto" | "legacy-tee" | "eager-relay";
```

Zod/validation: mirror wherever OcxConfig fields are validated (check types.ts
schema or config parse — loadConfig uses a result.success parse at config.ts:658;
add the enum there in the same shape as fastMode).

### MODIFY src/server/management/config-routes.ts

Expose `streamMode` in GET/PUT config the same way `fastMode` is exposed
(find fastMode handling; replicate: read from config, validate against the
3-value enum, saveConfig). Reject invalid values with 400.

## Activation scenarios (C-ACTIVATION-GROUNDING-01)

- decide("auto", "1.3.14", null) → {false, "auto-known-bad"} (today's default).
- decide("auto", "1.4.0", "1.4.0") → {true, "auto-fixed-runtime"} (future bump).
- decide("eager-relay", "1.3.14", null) → {true, "config-eager"} (brave opt-in).
- decide("legacy-tee", "9.9.9", "1.4.0") → {false, "config-legacy"} (pin).
- parse garbage version → null → conservative false.

## TESTS — NEW tests/bun-stream-caps.test.ts

Cases: the five activation scenarios above + compareBunVersions ordering +
parseBunVersion("1.3.14-canary.1") → [1,3,14] + config-routes PUT accepts the
three values and rejects "bogus" (extend existing config-routes test file if one
exists; else route-level test near tests/*config*).

## Verification (C)

- bun x tsc --noEmit → exit 0
- bun test tests/bun-stream-caps.test.ts → pass
- bun run test full suite → pass (config surface touched)
- bun run privacy:scan → pass
