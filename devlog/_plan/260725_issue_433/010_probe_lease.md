# 010 — probe lease 구현 계약

근거와 활성화 경로는 `000_plan.md` 참조. 이 문서는 구현 계약만 담는다.

## 불변식

1. 계정당 동시 lease 최대 1개.
2. lease를 소지한 outcome만 하드 cooldown을 해제한다.
3. `Retry-After` 유래 cooldown은 probe 대상이 아니다.
4. **lease는 자신이 발급된 cooldown 세대에만 유효하다.** lease 취득 후 cooldown이
   갱신되면 그 lease의 success는 새 cooldown을 해제하지 못한다.
5. lease 없는 2xx는 cooldown을 보존한다 (기존 테스트 `:312`, `:806`).

### 불변식 4가 필요한 이유

A-gate에서 발견된 우회 경로다. reset-derived cooldown에서 probe lease가 나간 뒤,
다른 비-lease 요청이 `429 Retry-After: 7200`을 받아 cooldown을 retry-after 출처로
갱신한다. 그 후 원래 probe의 2xx가 도착하면 lease가 일치하므로 상태 전체가 삭제되어
**새로 받은 명시적 Retry-After가 우회된다.** 불변식 3과 정면 충돌하는 quota 우회다.

해결: cooldown이 새로 기록될 때마다 세대 번호를 올리고, lease에 발급 시점의 세대를
박아 둔다. success 시 `leaseId` 일치뿐 아니라 `generation` 일치도 요구한다.

## lease 생명주기: TTL 대신 명시적 반납

TTL 회수는 불변식 1을 깨뜨린다. 요청 총 실행시간에 상한이 없어(`connectTimeoutMs`는
응답 헤더 대기 시간일 뿐) 스트리밍 중 TTL이 만료되면 두 번째 probe가 동시에 나간다.

**결정: TTL을 쓰지 않는다.** lease는 outcome 기록 또는 명시적 반납으로만 종료된다.
누수 시 최악은 cooldown 만료까지 probe가 없는 것인데, 이는 현재 동작과 동일하므로
회귀가 아니다. 안전한 실패 방향이다.

### 반납 책임 (upstream 전송 전에 끝나는 경로)

| 위치 | 상황 |
|---|---|
| `auth-context.ts:138` | `getMainAccountToken()` null → `CodexPoolAuthenticationError` |
| `auth-context.ts:146` catch | `getValidCodexToken()` 실패 → `CodexAuthContextError` |
| `core.ts:854` | `isCodexAuthContextUsable()` false → 401 반환 |
| `openai-sidecar.ts:92` | sidecar가 auth 후 요청을 보내지 않고 끝나는 경로 |

앞의 두 곳은 `resolveCodexAuthContext()` 내부라 lease id를 알고 있으므로 그 자리에서
반납한다. 뒤의 두 곳은 반환된 `authCtx.probeLeaseId`로 반납한다.

## 상태 전이표

`L` = outcome meta의 `probeLeaseId`가 저장된 lease id와 일치하고 **세대도 일치**.

| outcomeClass | L | 동작 |
|---|---|---|
| `success` | 예 | `upstreamHealth.delete()` — probe 성공, cooldown 해제 |
| `success` | 아니오 | 기존 동작 유지 (cooldown 보존, soft-avoid 정리) |
| `quota` | 예 | cooldown 갱신 + **세대 증가**, lease 해제, `lastProbeAt=now` |
| `quota` | 아니오 | cooldown 갱신 + 세대 증가, 기존 lease/probe 상태 보존 |
| `transient` | 예 | cooldown 유지, lease 해제, `lastProbeAt=now` |
| `transient` | 아니오 | 기존 동작 + probe 상태 보존 |
| `caller` | 예 | lease만 해제, `lastProbeAt=now` (현재는 early return) |
| `caller` | 아니오 | 기존 동작 (early return, 상태 변화 없음) |
| `credential` | 예/아니오 | **reauth가 quota 상태를 대체한다.** 현재 동작대로 health를 reauth 상태로 덮어쓰고 lease도 함께 사라진다. 401/403은 계정이 쓸 수 없다는 뜻이므로 cooldown 유지가 무의미하다 |
| `unknown` | — | `classifyCodexUpstreamOutcome()`이 `unknown`을 반환하는 경우 현재 코드는 transient와 같은 분기로 내려간다. transient 행과 동일하게 처리한다 |

핵심: 일치하지 않는 outcome은 lease를 소비하지 않는다. 다른 in-flight 요청의 503이
진행 중인 probe를 죽이지 못한다.

## 변경 파일

| 파일 | 종류 |
|---|---|
| `src/codex/routing.ts` | MODIFY |
| `src/codex/auth-context.ts` | MODIFY |
| `src/server/responses/core.ts` | MODIFY (meta 추가 + 반납) |
| `src/server/responses/compact.ts` | MODIFY (meta 추가) |
| `src/providers/openai-sidecar.ts` | MODIFY (meta 추가 + 반납) |
| `tests/codex-routing.test.ts` | MODIFY |

### `src/codex/routing.ts`

상수 (43행 뒤):

```ts
const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
```

`CodexUpstreamHealth` 추가 필드:

```ts
  cooldownSince?: number;
  cooldownSource?: "retry-after" | "reset-derived" | "default";
  /** Bumped on every cooldown write; binds a lease to the cooldown it was issued for. */
  cooldownGeneration?: number;
  probeLeaseId?: string;
  probeLeaseGeneration?: number;
  lastProbeAt?: number;
```

`computeQuotaCooldownUntil()`(168행)은 현재 `number`를 반환하고 소비자는 499행 한 곳뿐이며
테스트 import도 없다(확인 완료). `{ until, source }`로 바꾼다.

`parseResetCooldownMs()`(161행): `Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS)`.

신규 export:

```ts
export function tryAcquireCodexQuotaProbeLease(accountId: string, now?: number): string | null
export function releaseCodexQuotaProbeLease(accountId: string, leaseId: string): void
```

`tryAcquire` 가드 순서: cooldown 활성 → `cooldownSource !== "retry-after"` →
`probeLeaseId === undefined` → `now - (lastProbeAt ?? cooldownSince) >= INTERVAL`.
성공 시 새 `probeLeaseId`와 현재 `cooldownGeneration`을 함께 저장한다.

`CodexUpstreamOutcomeMeta`에 `probeLeaseId?: string` 추가.

### `src/codex/auth-context.ts`

`CodexAuthContext`의 `pool`/`main-pool` variant에 `probeLeaseId?: string` 추가.
132행에서 lease 획득, 138·146행 실패 경로에서 반납.

### outcome 기록 지점 (8곳 — 전수)

| 위치 | 컨텍스트 변수 |
|---|---|
| `core.ts:123` `sidecarOutcomeRecorder` | `authCtx` (이미 pool로 좁혀짐) |
| `core.ts:210` terminal recorder — incomplete | `authCtx` (좁혀짐) |
| `core.ts:225` terminal recorder — completed/failed | `authCtx` (좁혀짐) |
| `core.ts:1027` transport 실패 | `authCtx` |
| `core.ts:1081` **모델 400 계정 재시도** | `firstAuthCtx` |
| `core.ts:1160` HTTP 상태 | `authCtx` |
| `compact.ts:255` `recordCompactPoolOutcome` | `authCtx` (클로저) |
| `openai-sidecar.ts:91` | `authContext` |

`core.ts:1081`이 중요하다. 첫 계정의 caller outcome을 기록한 뒤 다른 계정으로 전환하므로,
`firstAuthCtx.probeLeaseId`를 넘기지 않으면 첫 계정의 lease가 소비되지 않고 고착된다.

각 호출의 meta에 해당 컨텍스트의 `probeLeaseId`를 추가한다. 시그니처 변경은 없다.

`collaboration.ts`/`encrypted-payload.ts`는 import만 있고 `resolveCodexAuthContext()` 호출은
없다(확인 완료).

## 회귀 테스트

### `tests/codex-routing.test.ts`

1. `far-future resetAt is capped below the 24h ceiling`
2. `Retry-After keeps honoring long explicit delays`
3. `retry-after cooldown is never probed` — interval 경과 후에도 `tryAcquire`가 null
4. `probe lease is granted at most once per interval`
5. `leased probe success clears the hard cooldown`
6. `unleased 2xx preserves the hard cooldown`
7. `mismatched lease id does not consume the probe`
8. `failed probe releases the lease and restarts the interval`
9. `stale-generation lease cannot clear a newer cooldown` — **불변식 4 회귀**
   - reset-derived cooldown → lease 취득(id=X, gen=1)
   - 비-lease 429 `Retry-After: 7200` → cooldown 갱신, gen=2
   - id=X를 가진 200 기록 → **cooldown이 유지되어야 한다**
   - 이게 없으면 명시적 Retry-After가 우회된다
10. `credential failure ends the probe` — 401 기록 후 reauth 상태, lease 없음
11. 기존 `:312`, `:806`이 **무수정 통과**

### 통합 테스트 (`tests/server-auth.test.ts` 또는 신규)

단위 테스트만으로는 선택기 → auth-context 배선을 검증하지 못한다. 구현 실수로 auth의
기존 cooldown throw가 lease 취득보다 먼저 남아 있어도 위 테스트는 모두 통과한다.

12. `main account probe reaches auth and recovers`
    - 활성 `__main__`에 reset-derived cooldown 설정
    - interval 전: 요청이 429
    - interval 후: `resolveCodexAuthContext()`가 `main-pool` 컨텍스트와 lease id 반환
    - 그 lease로 200 기록 → 다음 요청이 정상 통과

## 보안 검토 (MAINTAINERS.md:22)

구현 후 확인:

- lease가 계정당 동시 1개인가.
- `Retry-After` cooldown에서 lease가 절대 발급되지 않는가.
- 세대 불일치 lease가 새 cooldown을 해제하지 못하는가 (테스트 9).
- 실패한 probe가 반드시 interval을 재시작하는가.

## 검증

```bash
bun run typecheck
bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/server-auth.test.ts
```
