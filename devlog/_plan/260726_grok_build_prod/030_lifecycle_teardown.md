---
created: 2026-07-26
status: plan
phase: wp3
blockers: [B2, B6]
tags: [grok-build, lifecycle, service, teardown]
---

# 030 — 라이프사이클 teardown 정합성 (B2, B6)

대상 파일: `src/service.ts`, `src/cli/index.ts`, `src/server/management-api.ts`.
근거: `000_blocker_inventory.md` B2/B6 + 라이프사이클 인벤토리(서브에이전트 실측).

## 실측된 현재 상태

| 경로 | 서비스 매니저 | Grok fence | 문제 |
|------|--------------|-----------|------|
| `ocx stop` (정상) | 정지 | strip | 정상 |
| `ocx stop` (소유권 불일치) | **살아있음** | strip | B2 — 공유 설정만 제거 |
| `ocx service stop` | 정지 | **남음** | B6 확장 — Codex는 복원하면서 grok은 방치 |
| `ocx service uninstall` | 제거 | **남음** | B6 확장 — 영구 방치 |
| `POST /api/stop` | 정지 시도 | **남음** | B6 + 가드 없는 throw로 500 |
| 서비스 프록시 크래시/재spawn | — | 남음 | 의도된 배제, 유지 |

`stopServiceIfInstalled()`는 세 결과를 두 채널로 뭉갠다: `false`는 "미설치 또는 정지 실패",
throw는 "소유권 불일치"뿐이다. 호출자가 올바르게 분기할 수 없다.

## B2 — 소유권 실패를 구분 가능한 타입으로

### 1. 오류 타입 도입 (`src/service.ts`)

```ts
/** 서비스가 다른 CODEX_HOME/OPENCODEX_HOME에 설치되어 이 프로세스가 건드릴 수 없음. */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}
```

`assertServiceEnvironmentMatchesInstall()`의 두 throw를 이 타입으로 바꾼다. 메시지 문구는
그대로 유지한다 — 기존 테스트(`service.test.ts:199`)와 사용자에게 익숙한 안내를 깨지 않는다.

타입 판별 헬퍼도 함께 export한다:

```ts
export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}
```

### 2. `handleStop`이 공유 자원 teardown을 게이트 (`src/cli/index.ts`)

```ts
let ownershipBlocked = false;
try {
  stoppedService = stopServiceIfInstalled();
  ...
} catch (err) {
  if (isServiceOwnershipError(err)) {
    ownershipBlocked = true;
    stopFailed = true;
    console.error(`❌ ${err.message}`);
    console.error("   Skipping shared teardown: the installed service may still be running and would respawn the proxy.");
  } else {
    console.error(`⚠️  Service manager stop failed: ${...}`);
  }
}
```

그리고 공유 자원 정리(`restoreNativeCodex`, `revertSystemEnv`, `stripGrokConfig`)를
`if (!ownershipBlocked)`로 감싼다. 로컬 프록시 정지 자체는 그대로 시도한다 — 그것은
이 홈이 소유한 자원이다.

**restart 영향:** `handleStop`이 `stopFailed`로 `process.exit(1)`하면 `handleEnsure`가 실행되지
않는다. 소유권 불일치 상태에서 재주입까지 진행하는 것은 오히려 위험하므로 이 동작이 옳다.
사용자는 올바른 홈에서 다시 실행하라는 안내를 받는다.

## B6 — 명시적 종료 경로에서 fence 제거

### 3. `serviceCommand`의 `stop` / `uninstall` (`src/service.ts`)

두 경로 모두 `restoreNativeCodex()` 직후에 grok strip을 추가한다. 순환 의존을 피하려고
`src/cli/index.ts`가 쓰는 것과 같은 정적 import를 쓴다(`src/grok/inject.ts`는 `src/config`와
`src/codex/inject`만 의존하므로 안전).

```ts
const g = stripGrokConfig();
if (g.changed) console.log(`↩️  ${g.message}`);
else if (!g.ok) console.error(`⚠️  ${g.message}`);
```

이 두 경로는 이미 맨 앞에서 `assertServiceEnvironmentMatchesInstall()`을 부르고 예외를 전파하므로
소유권 게이트는 이미 만족한다.

### 4. `POST /api/stop` (`src/server/management-api.ts`)

현재 6줄에 문제가 셋이다. 함께 고친다:

```ts
if (url.pathname === "/api/stop" && req.method === "POST") {
  const { restoreNativeCodex } = await import("../codex/inject");
  const { stopServiceIfInstalled, isServiceOwnershipError } = await import("../service");
  try {
    stopServiceIfInstalled();
  } catch (err) {
    if (isServiceOwnershipError(err)) {
      // 설치된 서비스를 정지시킬 수 없다 = 공유 설정을 건드리면 안 되고, 종료해도 즉시 되살아난다.
      return jsonResponse({ success: false, message: err.message }, 409);
    }
    throw err;
  }
  const restore = restoreNativeCodex();
  const { stripGrokConfig } = await import("../grok/inject");
  const grok = stripGrokConfig();
  setTimeout(...);
  ...
}
```

`jsonResponse`가 상태 코드 인자를 받지 않으면 기존 시그니처를 확인해 맞춘다.
응답 메시지에 grok strip 결과를 합쳐 대시보드가 상태를 볼 수 있게 한다.

`OCX_SERVICE=1` 크래시/재spawn 배제(`syncCleanup`의 게이트)는 **그대로 둔다** — 이 변경은
명시적 종료 경로에만 strip을 추가한다.

## 회귀 테스트 (뼈대만; 상세는 040에서)

- 소유권 불일치 시 `handleStop`이 strip을 건너뛰고 실패 종료 코드를 남긴다.
- `service stop`/`uninstall`이 strip을 호출한다.
- `/api/stop`이 strip을 호출하고, 소유권 불일치에는 409로 응답하며 프록시를 종료하지 않는다.
- `syncCleanup`의 `OCX_SERVICE` 배제가 그대로 남아 있다.

## 게이트

`bun test tests/service.test.ts tests/grok-*.test.ts` → `bun run typecheck` → 전체 `bun run test`.
