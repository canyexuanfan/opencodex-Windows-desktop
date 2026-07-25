# WP1 — #433 먼 미래 resetAt로 인한 quota cooldown 고착

> 개정 이력: r1 초안은 A-gate에서 FAIL. blocker 1·2·3(카나리 도달 불가, 무조건 delete로
> 인한 기존 테스트 2건 회귀, transient 경로에서 probe 상태 소실)을 반영해 r2에서
> **probe lease** 설계로 전면 교체했다. 외부 근거는 `001_external_evidence.md` 참조.

## 증상

상위 ChatGPT/Codex 계정이 `usage_limit_exceeded`와 함께 며칠 뒤의 reset 타임스탬프를
돌려주면, 프록시가 그 값에서 로컬 cooldown을 파생해 24h 상한까지 계정을 묶는다.
이후 모든 요청이 `durationMs: 5`로 로컬에서 429 차단된다. 제보자의 계정은 약 2.5시간 만에
실제로 회복했지만 프록시는 24h 동안 계속 막았을 것이다. 해제 수단은 프록시 재시작뿐이다.

## 근본 원인

두 개의 결함이 겹친다.

### 1. weekly reset을 rate-limit 힌트처럼 취급한다

`src/codex/routing.ts:151` `parseResetCooldownMs()`는 resetAt까지 남은 시간을 그대로
cooldown으로 쓰고 `clampCooldownMs()`로 24h까지만 자른다.

`Retry-After`는 "이만큼 뒤에 다시 오라"는 지시지만, weekly/monthly quota의 `resetAt`은
"이때 창이 갱신된다"는 정보일 뿐 그 전까지 사용 불가라는 뜻이 아니다.

### 2. 하드 cooldown을 해제할 경로가 재시작밖에 없다

`src/codex/routing.ts:474`의 주석이 현재 의도를 명시한다.

```ts
    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
    // Hard quota cooldown intentionally survives either recovery path.
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, cooldownUntil });
```

cooldown이 걸린 계정은 `src/codex/auth-context.ts:132`에서 선차단되어 요청이 나가지
않으므로 성공 응답이 발생할 기회 자체가 없다. 자기 완결적 교착이다.

## 설계 제약 (A-gate에서 확인된 사실)

r1 초안을 무효화한 세 가지 실측 사실이다. 구현은 이 제약을 반드시 만족해야 한다.

**C1. `getCodexAccountCooldownUntil()`은 한 요청에서 여러 번 호출된다.**
`resolveCodexAccountForThreadDetailed()`(routing.ts:443)와
`buildCodexAuthContext()`(auth-context.ts:132), `assertCodexAuthContextNotCooled()`
(auth-context.ts:161)가 각각 조회한다. 따라서 **조회 시점에 카나리를 소비하면**
첫 호출이 통과시킨 뒤 두 번째 호출이 다시 막아 요청이 429로 끝난다. 조회는 무상태여야 하고,
lease 획득은 auth 단계에서 딱 한 번 일어나야 한다.

**C2. cooldown 계정의 2xx가 반드시 카나리인 것은 아니다.**
요청 A가 진행 중일 때 요청 B의 429가 cooldown을 설정하고, 그 뒤 A가 200으로 끝날 수 있다.
기존 테스트 두 개가 이 의미를 명시적으로 고정하고 있다.

- `tests/codex-routing.test.ts:312` `2xx responses clear transient failures without clearing an unexpired cooldown`
- `tests/codex-routing.test.ts:806` `2xx clears soft-avoid but preserves hard quota cooldown`

따라서 **무조건 `delete()`는 회귀다.** lease를 소지한 요청의 성공만 cooldown을 지워야 한다.

**C3. transient 경로가 probe 상태를 버린다.**
`routing.ts:526`의 transient 기록은 `cooldownUntil`만 보존한다. 카나리가 503/timeout이면
`cooldownSince`/`lastProbeAt`이 사라져 다음 probe가 불가능해진다.

## 수정 방향

이슈 제안 1·2번을 채택한다. 3·4번(CLI escape hatch, 상태 가시화)은 CLI/GUI 표면이라 범위 밖.

- **파생 상한 분리**: `Retry-After`는 24h까지 존중하되 `resetAt` 파생 cooldown은 낮게 자른다.
- **probe lease**: 상한을 넘긴 cooldown은 주기적으로 요청 하나에 lease를 발급한다.
  lease를 소지한 요청만 upstream까지 나가고, 그 요청의 성공만 cooldown을 해제한다.

### 보안 검토 필요 (MAINTAINERS.md)

이 변경은 계정 선택·차단 의미를 바꾸지만 크리덴셜 저장·전송 경로는 건드리지 않는다.
그래도 quota 우회로 오용될 여지가 있으므로, 구현 후 다음을 명시적으로 확인한다:
lease는 계정당 동시 1개이며, lease 발급 간격이 상한보다 짧아질 수 없고,
lease 실패 시 cooldown이 반드시 연장된다.

## Diff-level 변경안

### `src/codex/routing.ts`

**(1) 상수** — 42-44행 뒤에 추가:

```ts
 const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
 const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
+/**
+ * A weekly/monthly `resetAt` announces a window refresh; it is not a retry
+ * directive like Retry-After. Plan quota often frees up long before the
+ * advertised reset, so cap reset-derived cooldowns far below the 24h ceiling (#433).
+ */
+const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
+/** Minimum gap between probe leases for one cooled-down account. */
+export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
```

**(2) 상태 필드** — `CodexUpstreamHealth`(33행 부근):

```ts
   /** Hard cooldown (quota 429). Survives a later 2xx; blocks auth + selection. */
   cooldownUntil?: number;
+  /**
+   * Probe lease. A cooled-down account never sends traffic, so no organic 2xx can
+   * prove recovery. `probeLeaseAt` marks the moment a single request was allowed
+   * through; ONLY that request's outcome may clear the cooldown (#433).
+   */
+  probeLeaseAt?: number;
+  /** Last probe attempt (granted or concluded) — the lease interval's origin. */
+  lastProbeAt?: number;
```

**(3) 파생 상한 분리** — `parseResetCooldownMs()` 내부 (161행):

```ts
-    const clamped = clampCooldownMs(delay);
+    const clamped = Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS);
```

**(4) 조회는 무상태 유지** — `getCodexAccountCooldownUntil()`(175-178행)은 **변경하지 않는다.**
C1 때문이다. 대신 lease 소지 여부만 반영하는 얇은 래퍼를 추가한다.

```ts
+/** True when this account currently holds a probe lease (its request may go out). */
+export function hasCodexQuotaProbeLease(accountId: string): boolean {
+  return upstreamHealth.get(accountId)?.probeLeaseAt !== undefined;
+}
+
+/**
+ * Atomically grant at most one probe lease per interval. Called ONCE per request
+ * from the auth path — never from selection, which may run several times per
+ * request and would otherwise burn the lease before the request goes out (#433).
+ */
+export function tryAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): boolean {
+  const health = upstreamHealth.get(accountId);
+  const cooldownUntil = health?.cooldownUntil;
+  if (typeof cooldownUntil !== "number" || cooldownUntil <= now) return false;
+  if (health!.probeLeaseAt !== undefined) return false; // one in flight already
+  const origin = health!.lastProbeAt ?? health!.cooldownSince ?? now;
+  if (now - origin < CODEX_QUOTA_PROBE_INTERVAL_MS) return false;
+  upstreamHealth.set(accountId, { ...health!, probeLeaseAt: now, lastProbeAt: now });
+  return true;
+}
```

`cooldownSince`도 함께 둔다 (quota 기록 시 `now`).

**(5) quota 기록** — 493-500행:

```ts
   if (outcomeClass === "quota") {
+    // A failed probe concludes its lease and restarts the interval clock, so the
+    // next probe waits a full interval instead of retrying immediately.
+    const prior = upstreamHealth.get(accountId);
     upstreamHealth.set(accountId, {
       consecutiveFailures: 0,
       lastFailureStatus,
       lastFailureAt: now,
       cooldownUntil: computeQuotaCooldownUntil(meta),
+      cooldownSince: prior?.cooldownSince ?? now,
+      lastProbeAt: now,
+      // probeLeaseAt intentionally dropped — the lease is consumed.
     });
```

**(6) success 경로** — 460-478행. C2를 지켜 **lease 소지 시에만** 해제한다:

```ts
   if (outcomeClass === "success") {
     const current = upstreamHealth.get(accountId);
     const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
+    // Only a leased probe proves recovery. A plain 2xx may be an in-flight request
+    // that started before the 429 landed, so it must NOT clear a quota cooldown
+    // (tests/codex-routing.test.ts:312 and :806 pin this).
+    if (cooldownUntil && current?.probeLeaseAt !== undefined) {
+      upstreamHealth.delete(accountId);
+      return;
+    }
     const failoverEnabled = ...
```

이후 기존 escalation 로직과 `if (cooldownUntil) upstreamHealth.set(...)` 보존 분기는
**그대로 둔다**. 단 보존 시 `probeLeaseAt`/`lastProbeAt`/`cooldownSince`를 함께 유지한다.

**(7) transient 경로** — 526행. C3를 지켜 probe 상태를 보존한다:

```ts
   upstreamHealth.set(accountId, {
     consecutiveFailures,
     lastFailureStatus,
     lastFailureAt: now,
     ...(hardCooldownUntil ? { cooldownUntil: hardCooldownUntil } : {}),
+    // Preserve probe bookkeeping: a 503/timeout probe must still conclude its
+    // lease and restart the interval, not lose the clock entirely (#433 C3).
+    ...(current?.cooldownSince !== undefined ? { cooldownSince: current.cooldownSince } : {}),
+    ...(hardCooldownUntil && current?.probeLeaseAt !== undefined ? { lastProbeAt: now } : {}),
     ...(softAvoidUntil !== undefined ? { softAvoidUntil } : {}),
   });
```

`probeLeaseAt`은 여기서도 전달하지 않는다 — 실패한 probe는 lease를 소비한다.

### `src/codex/auth-context.ts` (132행)

lease 획득은 여기 단 한 곳이다.

```ts
   const cooldownUntil = getCodexAccountCooldownUntil(accountId);
-  if (cooldownUntil) throw new CodexAccountCooldownError(accountId, cooldownUntil);
+  if (cooldownUntil && !tryAcquireCodexQuotaProbeLease(accountId)) {
+    throw new CodexAccountCooldownError(accountId, cooldownUntil);
+  }
```

`assertCodexAuthContextNotCooled()`(161행)도 lease를 존중해야 한다. 그렇지 않으면 C1대로
두 번째 관문에서 다시 막힌다.

```ts
   const cooldownUntil = getCodexAccountCooldownUntil(ctx.accountId);
-  if (cooldownUntil) throw new CodexAccountCooldownError(ctx.accountId, cooldownUntil);
+  if (cooldownUntil && !hasCodexQuotaProbeLease(ctx.accountId)) {
+    throw new CodexAccountCooldownError(ctx.accountId, cooldownUntil);
+  }
```

선택 로직(`isCodexAccountSelectable`, `resolveCodexAccountForThreadDetailed`)은 **변경하지
않는다.** cooldown 계정은 pool 선택에서 계속 회피되고, 단일 계정이라 fallback이 없을 때만
`hasConfiguredPoolAccount` 경로로 auth까지 도달해 lease를 시도한다. 이게 #433의 실제
시나리오(단일 `__main__` 계정)다.

> 구현 시 확인 필요: pool에 건강한 대체 계정이 있으면 cooled 계정은 선택되지 않으므로
> lease 기회가 오지 않는다. 이는 의도된 동작이다 — 건강한 계정이 있는데 굳이 cooled
> 계정을 시험할 이유가 없다. 다만 모든 계정이 cooled인 경우도 같은 경로로 도달하는지
> B 단계에서 `resolveCodexAccountForThreadDetailed`를 재확인한다.

## 회귀 테스트

`tests/codex-routing.test.ts`에 추가한다.

1. `far-future resetAt is capped well below the 24h ceiling`
   - `resetAt` 4일 뒤 + quota 429 → `cooldownUntil - now <= CODEX_MAX_RESET_DERIVED_COOLDOWN_MS`
   - 수정 전 실패: 24h로 clamp

2. `Retry-After keeps honoring long explicit delays`
   - `Retry-After: 7200` → cooldown 2시간 유지 (reset 상한이 명시 지시를 깎지 않음)

3. `probe lease is granted at most once per interval`
   - quota 429 직후 `tryAcquireCodexQuotaProbeLease()` → `false`
   - `+CODEX_QUOTA_PROBE_INTERVAL_MS` → `true`
   - 곧바로 재호출 → `false` (동시 lease 1개)

4. `selection and auth checks stay consistent within one request` — **C1 회귀**
   - lease 획득 후 `getCodexAccountCooldownUntil()`이 여전히 값을 반환하지만
     `hasCodexQuotaProbeLease()`가 `true`
   - 즉 두 번째 관문이 같은 요청을 막지 않음

5. `leased probe success clears the hard cooldown`
   - quota 429 → lease 획득 → 200 → `getCodexUpstreamHealth()`가 `null`

6. `unleased 2xx preserves the hard cooldown` — **C2 회귀, 기존 :312/:806과 동일 의미**
   - quota 429 → lease 없이 200 → cooldown 유지

7. `failed probe restarts the interval and drops the lease`
   - lease 획득 → 429 → `hasCodexQuotaProbeLease()`가 `false`이고
     즉시 재획득 시도가 `false`

8. `transient probe failure keeps probe bookkeeping` — **C3 회귀**
   - lease 획득 → 503 → cooldown 유지, `lastProbeAt`이 갱신되어
     `+interval` 후 재획득이 `true`
   - timeout과 connect_error에 대해서도 같은 단언

9. 기존 `2xx responses clear transient failures without clearing an unexpired cooldown`
   (:312)과 `2xx clears soft-avoid but preserves hard quota cooldown`(:806)이
   **수정 없이 계속 통과**해야 한다. 이 둘이 깨지면 설계가 틀린 것이다.

### 통합 테스트

단위 테스트만으로는 C1을 완전히 증명하지 못한다. `tests/server-auth.test.ts` 또는 신규
`tests/codex-quota-probe-e2e.test.ts`에서 `handleResponses()`를 통해
429 → interval 경과 → probe가 실제 upstream fetch까지 도달 → 200 → 다음 요청이 정상
통과하는 흐름을 mock fetch로 검증한다.

## 유지해야 할 동작

- `Retry-After`의 24h 상한과 리터럴 존중.
- credential(401/403) 및 transient(5xx/timeout) 분류 경로는 무변경.
- pool에서 cooldown 계정을 회피하는 선택 로직(`isCodexAccountSelectable`)의 의미.
- `clearCodexUpstreamHealthForAccount()` 기반 계정 생명주기 훅.

## 검증 명령

```bash
bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/server-auth.test.ts
bun run typecheck
```
