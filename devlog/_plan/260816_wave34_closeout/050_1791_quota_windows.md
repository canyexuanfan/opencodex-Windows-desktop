# 050 — #1791: keep every quota window, not two named ones

## Verified defect

Upstream sends three fixed slots, each a `WhamUsageWindow` with `used_percent`, `reset_at`, `limit_window_seconds` (`src/codex/quota.ts:38`).

Storage is not window-generic:

```ts
type StoredAccountQuota = {
  weeklyPercent?: number; monthlyPercent?: number;
  weeklyResetAt?: number; monthlyResetAt?: number;
  resetCredits?: number; monthlyIsPrimaryWindow?: boolean; updatedAt: number;
}
```

(`src/codex/quota.ts:7`, persisted as `{ version: 1, quotas }` at `:24`, `:357`, `:377`.)

`parseUsageQuota()` folds a non-monthly primary into `weekly` and treats secondary only as a fallback (`:439`, `:468`). A K12 account with a 5-hour primary and a 7-day secondary therefore reports the 5-hour window AS the weekly one, and the real weekly window disappears.

## Fix

Store windows as an array keyed by duration, and derive the display names instead of baking them in:

```ts
type StoredQuotaWindow = {
  limitWindowSeconds: number;   // the discriminator upstream already gives us
  usedPercent: number;
  resetAt?: number;
};
type StoredAccountQuota = {
  windows: StoredQuotaWindow[];
  resetCredits?: number;
  updatedAt: number;
};
```

Persist as `version: 2`. Hydration must accept BOTH: a `version: 1` document is upgraded in memory by mapping `weekly*` and `monthly*` onto synthetic windows (7d / 30d), so an existing install does not lose its quota state on upgrade. Writing always emits v2.

Exhaustion becomes "any governing window at limit", not "the weekly one", which is the behavior `#1791` asks for.

Consumers that ask for `weeklyPercent`/`monthlyPercent` (dashboard, routing) get a small accessor that selects by duration band rather than by stored name, so the display keeps working while the storage stops lying.

## Tests

- K12 payload: 5-hour primary + 7-day secondary produces two windows with independent reset times, and the weekly one is genuinely the 7-day.
- v1 document on disk hydrates without loss and re-persists as v2; a v2 document round-trips unchanged.
- Either window at 100% marks the account exhausted.
- Dashboard/routing accessors return the same values they used to for an ordinary two-window account.
