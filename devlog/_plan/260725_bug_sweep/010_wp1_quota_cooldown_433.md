# WP1 — #433 먼 미래 resetAt로 인한 quota cooldown 고착

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

```ts
export function parseResetCooldownMs(resetAt: unknown | unknown[] | undefined, now = Date.now()): number | undefined {
  const values = Array.isArray(resetAt) ? resetAt : [resetAt];
  let best: number | undefined;
  for (const value of values) {
    const timestamp = resetTimestampMs(value);
    if (timestamp === undefined) continue;
    const delay = timestamp - now;
    if (delay <= 0) continue;
    const clamped = clampCooldownMs(delay);
    if (best === undefined || clamped < best) best = clamped;
  }
  return best;
}
```

`Retry-After`는 "이만큼 뒤에 다시 오라"는 지시지만, weekly/monthly quota의 `resetAt`은
"이때 창이 갱신된다"는 정보일 뿐 그 전까지 사용 불가라는 뜻이 아니다. 실제로 플랜 단위
quota는 광고된 reset보다 훨씬 먼저 풀리는 경우가 많다.

### 2. 하드 cooldown을 해제할 경로가 재시작밖에 없다

`src/codex/routing.ts:474`의 주석이 현재 의도를 명시한다.

```ts
    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
    // Hard quota cooldown intentionally survives either recovery path.
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, cooldownUntil });
```

성공 응답으로도 하드 cooldown이 살아남는다. 그런데 cooldown이 걸린 계정은 애초에
요청이 나가지 않으므로(`src/codex/auth-context.ts:132`에서 선차단) 성공 응답이 발생할
기회 자체가 없다. 자기 완결적 교착이다.

```ts
  const cooldownUntil = getCodexAccountCooldownUntil(accountId);
  if (cooldownUntil) throw new CodexAccountCooldownError(accountId, cooldownUntil);
```

`getCodexAccountCooldownUntil()`은 `auth-context.ts`(2곳)와 routing 내부 선택 로직이
모두 통과하는 단일 게이트다. 여기에 재프로브를 넣으면 모든 소비처가 한 번에 고쳐진다.

## 수정 방향

이슈 제안 1·2번을 채택한다. 3·4번(CLI escape hatch, 상태 가시화)은 CLI/GUI 표면을
건드리므로 이번 범위 밖으로 둔다.

- **파생 상한 분리**: `Retry-After`는 지금처럼 24h까지 존중하되, `resetAt`에서 파생한
  cooldown은 훨씬 낮은 상한으로 자른다.
- **카나리 재프로브**: 상한을 넘긴 cooldown은 일정 간격마다 요청 하나를 통과시킨다.
  그 요청이 성공하면 `recordCodexUpstreamOutcome`의 success 경로가 cooldown을 지운다.

두 번째가 핵심이다. 상한만 낮추면 "24h 대신 N분" 문제로 바뀔 뿐, 회복된 계정을
즉시 쓰지 못하는 구조는 그대로다.

## Diff-level 변경안

### `src/codex/routing.ts`

상수 추가 (현재 42-44행 부근):

```ts
const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
+/**
+ * A weekly/monthly `resetAt` is a window-refresh announcement, not a retry
+ * directive: plan quota often frees up long before the advertised reset. Cap
+ * reset-derived cooldowns far below the Retry-After cap so a far-future reset
+ * cannot pin an account for the full day (#433).
+ */
+const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
+/** After this much cooldown has elapsed, let one canary request through. */
+export const CODEX_QUOTA_CANARY_INTERVAL_MS = 5 * 60_000;
```

`CodexUpstreamHealth`에 카나리 추적 필드 추가 (현재 33행 부근):

```ts
  /** Hard cooldown (quota 429). Survives a later 2xx; blocks auth + selection. */
  cooldownUntil?: number;
+  /** When the cooldown began — the canary clock's origin. */
+  cooldownSince?: number;
+  /** Last time a canary probe was released through the cooldown. */
+  lastCanaryAt?: number;
```

`parseResetCooldownMs()`가 별도 상한을 쓰도록 변경 (현재 151-163행):

```ts
-    const clamped = clampCooldownMs(delay);
+    const clamped = Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS);
```

`getCodexAccountCooldownUntil()`에 카나리 창 추가 (현재 175-178행):

```ts
 export function getCodexAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
-  const cooldownUntil = upstreamHealth.get(accountId)?.cooldownUntil;
-  return typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : null;
+  const health = upstreamHealth.get(accountId);
+  const cooldownUntil = health?.cooldownUntil;
+  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return null;
+  // Canary: a cooled-down account never sends a request, so a real 2xx can never
+  // arrive to clear the cooldown. Periodically release exactly one probe; if it
+  // succeeds, recordCodexUpstreamOutcome() drops the cooldown for good (#433).
+  const since = health?.cooldownSince ?? cooldownUntil;
+  const lastCanary = health?.lastCanaryAt ?? since;
+  if (now - lastCanary >= CODEX_QUOTA_CANARY_INTERVAL_MS) {
+    upstreamHealth.set(accountId, { ...health!, lastCanaryAt: now });
+    return null;
+  }
+  return cooldownUntil;
 }
```

quota 기록 경로에 `cooldownSince` 세팅 (현재 493-500행):

```ts
   if (outcomeClass === "quota") {
+    const cooldownUntil = computeQuotaCooldownUntil(meta);
     upstreamHealth.set(accountId, {
       consecutiveFailures: 0,
       lastFailureStatus,
       lastFailureAt: now,
-      cooldownUntil: computeQuotaCooldownUntil(meta),
+      cooldownUntil,
+      cooldownSince: now,
     });
```

success 경로에서 cooldown이 실제로 지워지도록 변경 (현재 460-478행). 카나리가 성공하면
하드 cooldown도 해제해야 한다 — 이게 이 수정의 목적이다.

```ts
-    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
-    // Hard quota cooldown intentionally survives either recovery path.
-    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, cooldownUntil });
-    else upstreamHealth.delete(accountId);
+    // A 2xx from a cooled-down account can only come from a released canary, and
+    // it proves the upstream quota actually recovered. Clear the hard cooldown
+    // instead of holding it to the advertised reset (#433).
+    upstreamHealth.delete(accountId);
     return;
```

`cooldownUntil` 지역 변수가 이 분기에서 더 이상 쓰이지 않으므로, 위쪽 escalation 분기의
`...(cooldownUntil ? { cooldownUntil } : {})` 유지 여부를 함께 정리한다. escalation
분기는 아직 2연속 성공이 안 된 중간 상태이므로 cooldown을 유지하는 편이 맞다.

## 회귀 테스트

`tests/codex-routing.test.ts`에 추가한다. 이 파일은 이미
`computeQuotaCooldownUntil`/`getCodexUpstreamHealth`/`recordCodexUpstreamOutcome`을
import하고 있으며 320행에 유사한 cooldown 단언이 있다.

1. `far-future resetAt is capped well below the 24h ceiling`
   - `resetAt`을 4일 뒤로 주고 quota 429 기록
   - `cooldownUntil - now <= CODEX_MAX_RESET_DERIVED_COOLDOWN_MS`
   - 수정 전 실패: 24h(86,400,000ms)로 clamp됨

2. `Retry-After keeps honoring long explicit delays`
   - `Retry-After: 7200` (2시간)
   - cooldown이 2시간으로 유지됨 — reset 상한이 명시적 지시까지 깎지 않음을 고정

3. `canary probe is released after the interval`
   - quota 429 기록 후 즉시 `isCodexAccountInCooldown()` → `true`
   - `now + CODEX_QUOTA_CANARY_INTERVAL_MS` 시점 조회 → `false` (카나리 통과)
   - 곧바로 다시 조회 → `true` (카나리는 한 번만)
   - 수정 전 실패: 항상 `true`

4. `successful canary clears the hard cooldown`
   - quota 429 → 카나리 창에서 200 기록
   - `getCodexUpstreamHealth()`가 `null`
   - 수정 전 실패: `cooldownUntil`이 그대로 남음

5. `failed canary keeps the account cooled down`
   - quota 429 → 카나리 창에서 다시 429
   - 여전히 cooldown 상태이고 새 `cooldownSince`로 카나리 시계가 리셋됨

## 유지해야 할 동작

- `Retry-After`의 24h 상한과 리터럴 존중.
- credential(401/403) 및 transient(5xx/timeout) 분류 경로는 무변경.
- pool에서 cooldown 계정을 회피하는 선택 로직(`isCodexAccountSelectable`)의 의미.
- `clearCodexUpstreamHealthForAccount()` 기반 계정 생명주기 훅.

## 검증 명령

```bash
bun test tests/codex-routing.test.ts
bun run typecheck
```
