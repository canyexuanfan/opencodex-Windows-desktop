# 030 — state-store eviction mechanisms

Date: 2026-08-01  
Work phase: wp4  
Depends on: none  
Binding inputs: `000_state_store_inventory.md` §§4–6, `005_impl_roadmap.md` locked decision 3 and store-by-store lock, `006_roadmap_audit_synthesis.md` R1-2/R1-5/S2-5/S3-2.

## Outcome

Apply exactly three mechanisms, selected per store rather than by convenience:

1. exact clock-TTL sweep where current getters already treat an expired row as absent;
2. config/account-generation reconciliation where a key is owned by the current configuration;
3. admission or owner-specific release where a live resource cannot be evicted safely.

Live keys keep their current behavior. Warning memos and Codex quota rows never gain a
TTL. Windows ACL successes are removed only for the actual renamed temp path. Retained
diagnostic values are byte-normalized at admission in 035, not swept by time.

## Shared lifecycle utility

### NEW `src/lib/state-store-sweeper.ts`

```ts
export const STATE_SWEEP_INTERVAL_MS = 60_000;

export interface GenerationContext {
  generation: number;
  providerNames: ReadonlySet<string>;
  comboIds: ReadonlySet<string>;
  codexAccountIds: ReadonlySet<string>;
  oauthAccountKeys: ReadonlySet<string>;
  configRoots: ReadonlySet<string>;
}
export interface StateStoreRegistration {
  name: string;
  sweepExpired?: (now: number) => number;
  reconcileGeneration?: (context: GenerationContext) => number;
}
export interface StateSweepResult { storesVisited: number; rowsRemoved: number }

export function registerStateStore(registration: StateStoreRegistration): () => void;
export function sweepExpired(now?: number): StateSweepResult;
export function sweepExpiredOnWrite(now?: number): StateSweepResult;
export function reconcileStateGeneration(context: GenerationContext): StateSweepResult;
export function startStateStoreSweeper(options?: StateStoreSweeperOptions): { stop(): void };
export function stopStateStoreSweeper(): void;
```

Registration names are static and unique; replacement does not duplicate callbacks.
`startStateStoreSweeper()` replaces the prior singleton, creates one 60-second interval,
and invokes `unref?.()`. One callback failure logs only the static registration name and
does not stop later callbacks. `sweepExpiredOnWrite()` runs synchronously after a
successful owner write; it creates no promise tail. Reconciliation never runs from the
clock timer.

Start the singleton beside the watchdog in `src/server/index.ts:300-316`; stop it in
`drainAndShutdown()` at `src/server/lifecycle.ts:70-95`. If side-effect registration
would create an import cycle, add explicit wiring in NEW
`src/lib/state-store-registrations.ts`; do not add a generic helper module.

## Locked store-by-store table

The inventory shorthand `catalog/*` resolves to `src/codex/catalog/*` in this checkout.

| Store and current anchor | Locked mechanism | Diff-level owner change |
|---|---|---|
| Subagent `modelHealth`, `src/codex/subagent-model-fallback.ts:35-42,160-171,229-248` | TTL sweep | Export `sweepExpiredSubagentModelHealth(now)`; delete `unavailableUntil <= now`; invoke write sweep after `modelHealth.set`; never touch `quotaPrimedAt.global`. |
| Combo cooldown, `src/combos/failover.ts:5-19,40-77` | TTL sweep | Export/register `sweepExpiredComboTargetCooldowns(now)` and preserve every live Retry-After row. |
| API-key cooldown, `src/providers/key-failover.ts:17-53,89-130,174-190` | TTL sweep | Delete only `cooldownUntil <= now`; keep key ordering and current exact-key lazy cleanup. |
| Anthropic health, `src/oauth/anthropic-routing.ts:34-40,96-123` | TTL sweep | Export a health sweep using the same semantic deadline as `isCooled`; affinity at `:234-241` remains its existing 2,000/24 h LRU. |
| XAI permanent-failure verdicts, `src/oauth/index.ts:54-61,326-327` | TTL sweep | Globally delete the same 30-second-expired verdicts that `cached()` already treats as absent; S3-2 forbids reconciliation-only handling. |
| Warning memos, `src/codex/catalog/provider-fetch.ts:219`, `src/codex/catalog/aggregation.ts:37-39,281-283`, `src/router.ts:154-180`, `src/combos/request.ts:4-38`, `src/config.ts:435,2052-2053` | Reconciliation only | Clear/rebuild only after a complete new config generation. No TTL: time expiry would re-emit intentionally suppressed warnings. |
| Codex quota, `src/codex/quota.ts:15-27,51,261-326` | Reconciliation only | Remove accounts absent from current account generation and persist the reduced map. The 6 h rule is hydration admission, not live expiry. |
| Provider quota history, `src/providers/quota.ts:52-61,195-239,278-342` | Reconciliation plus admission | Remove dead provider/account keys; cap distinct live flights in 035; never detach an accepted flight. |
| Codex routing health, `src/codex/routing.ts:85-138,209-243` | Reconciliation | Remove account-wide and quota-scope rows only for deleted accounts; preserve live Retry-After and probe generation. |
| Model-cache history, `src/codex/model-cache.ts:42-56,114-147` | Reconciliation | Add `reconcileModelCacheProviders(validProviders)` covering cache, failure, status, and live-count maps atomically. |
| Pool rotation, `src/codex/pool-rotation.ts:6-12,44-80,180-185` | Reconciliation | Remove deleted pool/account rows while preserving current sticky/RR weights. |
| Combo rotation, `src/combos/resolve.ts:13-20,85-105,161-167` | Reconciliation | Remove deleted combo ids and target weights; preserve current target order. |
| Guardian backoff, `src/oauth/token-guardian.ts:54-99,118-225` | Reconciliation | Remove deleted provider/account rows; keep a configured revoked account at its current backoff. |
| Reauth state, `src/codex/account-runtime-state.ts:1-13` plus OAuth account maps | Reconciliation | Remove only keys absent after a successful persisted account mutation. |
| GCP ADC, `src/lib/gcp-adc.ts:61-66,83-127,274-302` | Reconciliation plus admission | Remove source fingerprints absent from the authoritative ADC source set; cap active source flights in 035; retain current expiry-on-resolve. |
| Config ownership, `src/lib/config-ownership.ts:79-87,233-258` | Reconciliation | Remove a root only when absent from manifest/current roots and no owned path references it. Never infer inactivity from age. |
| PID and config warnings, `src/config.ts:413-435,2052-2053,2112-2121` | Reconciliation | Delete PID rows only after failed identity/liveness proof; warning rows follow config generation. |
| OAuth login/abort/manual maps, `src/oauth/index.ts:823-904,939-1020` | Reconciliation plus admission | Remove dead provider/account generations; 035 caps flows/probes and pending-code bytes; never evict an in-progress owner. |
| Active turns/sockets/workers/slots | Admission only | Implement the hard caps and coherent busy responses in 035; do not register an accepted owner and later sweep it away. |

Each owner exports a semantic sweep/reconcile function. The coordinator passes complete
sets; it must not recreate owner key strings. Add a monotonic config generation beside
the canonical loaded-config owner, and call reconciliation only after successful initial
load, successful disk commit, account add/delete/reauth commit, or catalog sync with the
complete provider/combo set. Failed parse/save and speculative routing do not advance it.

## Windows ACL delete-after-rename contract

Current anchors:

- `src/lib/windows-secret-acl.ts:37-40` retains directory/file success paths and timeout keys.
- `src/lib/windows-secret-acl.ts:363-367` permits a destination key only for timeout memoization.
- `src/lib/windows-secret-acl.ts:375-455` adds the actual `targetPath` after successful `icacls`.
- `src/config.ts:96-113,174-197` hardens unique `*.ocx.<pid>.<seq>.tmp` files, then renames them.

Add:

```ts
export function forgetHardenedSecretPath(targetPath: string): void {
  hardenedPaths.delete(targetPath);
}
export function hardenedSecretPathCountForTests(): number;
```

For both atomic writers the order is fixed:

```ts
io.harden(tmp);                 // memo belongs to this exact temp
io.rename(tmp, path);           // durable destination replacement
forgetHardenedSecretPath(tmp);  // only after successful rename
```

After a failed transaction, forget the success memo only after that exact temp has been
unlinked. If a hardened residual remains, keep its memo until removal. Never add the
destination to `hardenedPaths`, never reuse one temp's success for the next temp, and
never clear `timedOutPaths[destination]` on rename.

This code protects credential/config files and requires explicit security review under
`AGENTS.md`/`MAINTAINERS.md`. The security reviewer must specifically attest that the
second temp for one destination executes `icacls` again and failure remains fail-closed.

## Diagnostic values: classification, not a clock sweep

Crash trace strings at `src/lib/crash-guard.ts:206-245`, debug lines/subscribers at
`src/lib/debug-log-buffer.ts:3-35`, injection lines at
`src/lib/injection-debug-log.ts:10-27`, Claude metadata at
`src/claude/inbound-debug.ts:40-106`, fixed breadcrumbs at
`src/lib/sidecar-tracker.ts:10-48`, and affinity components at
`src/codex/routing.ts:105-109,624-688` / `src/oauth/anthropic-routing.ts:34-40,234-241`
have no expiry semantics. They therefore use mechanism 3: 035's UTF-8 byte admission
and truncation marker. Do not register them with `sweepExpired()` and do not truncate
tool JSON, credential values, or route keys into ambiguous identities.

## Regression cases

Add `tests/state-store-sweeper.test.ts`:

- `global fake-clock sweep visits every registered TTL owner once`
- `expiry boundary removes expired rows and preserves live rows`
- `one throwing owner does not block later sweep owners`
- `write-trigger uses the same callbacks without creating a queue`
- `timer start is singleton unrefed and stop is idempotent`
- `reconciliation runs only for a newer complete generation`
- `stale or duplicate generation cannot delete current keys`

Extend nearest owner suites with:

- `subagent health sweep removes expired untouched model keys`
- `combo and API-key sweeps preserve live Retry-After rows`
- `Anthropic health and XAI verdict sweeps use their exact semantic deadlines`
- `warning reconciliation never expires a current-generation warning by time`
- `Codex quota reconciliation ignores row age and removes only deleted accounts`
- `model-cache reconciliation removes all four maps for one deleted provider`
- `pool combo guardian GCP ownership and reauth reconciliation preserve current keys`

Extend `tests/windows-secret-acl.test.ts` and the atomic-writer cases in
`tests/config.test.ts`:

- `second atomic temp for the same destination is hardened again`
- `rename success forgets only the actual temp success memo`
- `destination timeout memo never vouches for a new temp`
- `failed unlink retains the residual temp success memo`
- `later successful residual cleanup forgets that exact memo`.

Verification:

```bash
bun test tests/state-store-sweeper.test.ts tests/windows-secret-acl.test.ts tests/config.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

## Explicitly not changed

- No TTL for warning memos or live Codex quota rows.
- No deletion of live Retry-After, accepted resources/flights, current sticky state,
  last-good models, or configured guardian backoff.
- No process-wide accounting interface; 030 provides sweeping only.
- No provider event semantics, `#820` scheduler architecture, destination-level ACL
  success memo, or fail-open hardening behavior.
