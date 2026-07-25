---
created: 2026-07-26
status: plan
phase: wp4
blockers: [B4]
tags: [grok-build, tests, lifecycle]
---

# 040 — CLI 라이프사이클 회귀 (B4)

대상 파일: `tests/helpers/isolated-grok-home.ts`(신규), `tests/grok-lifecycle.test.ts`(신규),
`tests/service.test.ts`, `tests/grok-config-inject.test.ts`.
근거: `000_blocker_inventory.md` B4 + 라이프사이클 커버리지 실측.

## 제약: `src/cli/index.ts`는 import할 수 없다

최상위에서 `switch (command)`를 실행하는 스크립트라 핸들러를 직접 호출할 수 없다.
이 저장소에는 이미 확립된 세 가지 방식이 있고, 각각 알맞은 자리에 쓴다.

| 스타일 | 용도 | 선례 |
|--------|------|------|
| A. 소스 슬라이스 순서 검증 | CLI 핸들러의 배선/순서 | `tests/stale-state-purge.test.ts:53`, `tests/uninstall.test.ts:41` |
| B. 주입 deps + 임시 디렉터리 | deps를 받는 유닛 | `tests/grok-sync.test.ts:12` |
| C. `mock.module` | 동적 import 가로채기 | `tests/vision-cache.test.ts:4` |

소스 슬라이스만으로는 "동작"을 증명하지 못한다는 한계가 있으므로, 실제 동작 검증이 가능한
계층(`serviceCommand`, `handleManagementAPI`, `stripGrokConfig`)은 B/C로 진짜 실행하고,
CLI 핸들러 배선은 A로 고정한다. 두 층을 합쳐야 B2가 통과했던 구멍이 막힌다.

## 신규 헬퍼: `tests/helpers/isolated-grok-home.ts`

`installIsolatedCodexHome`을 그대로 미러링한다. CLI 경로는 `stripGrokConfig()`를 인자 없이
부르므로 `grokHome` 옵션이 아니라 `GROK_HOME` 환경변수 격리가 필요하다.

```ts
export function installIsolatedGrokHome(prefix: string): { path: string; restore(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome, { recursive: true });
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = grokHome;
  return { path: grokHome, restore() { ... prev 복원, root 삭제 ... } };
}
```

두 grok 테스트 파일에 중복된 `tempGrokHome()`도 이 헬퍼로 통일한다.

## 테스트 목록

### 그룹 1 — 배선 (스타일 A, `tests/grok-lifecycle.test.ts`)

1. `handleStart`가 Desktop3P 등록 실패와 **무관하게** grok 동기화를 시도한다.
   현재는 grok inject가 Desktop3P try 블록 **안쪽**에 중첩돼, 카탈로그 조회가 던지면 fence가
   조용히 건너뛰어진다. 030에서 이 중첩을 형제 블록으로 분리하고, 이 테스트가 그 구조를 고정한다.
   검증: `handleStart` 슬라이스에서 `syncGrokConfig` 호출이 `buildDesktop3pRegistry`의 catch
   **뒤**에 독립 try로 존재.
2. `handleEnsure` 라이브 분기가 `live.hostname`을, spawn 분기가 `config.hostname`을 넘긴다
   (분기별로 정확한 호스트 출처를 고정 — 뒤바뀌면 잘못된 base_url을 쓴다).
3. `handleStop`에서 `stripGrokConfig()` 호출이 소유권 게이트 **안쪽**에 있다
   (`ownershipBlocked` 검사가 strip보다 앞선다).
4. `syncCleanup`의 `OCX_SERVICE` 배제가 유지된다.

### 그룹 2 — 실제 동작 (스타일 B/C)

5. `serviceCommand("stop")`이 fence를 실제로 제거한다.
   `installIsolatedGrokHome` + `installIsolatedCodexHome`로 격리하고, 플랫폼 ops는
   `mock.module`로 대체해 실제 launchd/systemd를 건드리지 않는다.
6. `serviceCommand("uninstall")` 동일.
7. 소유권 불일치 상태에서 `serviceCommand("stop")`이 **fence를 남긴 채** throw한다
   (`service-state.json` 세팅은 `tests/service.test.ts:188` 패턴 그대로).
8. `POST /api/stop`이 fence를 제거하고 성공 응답을 준다 —
   `handleManagementAPI`를 직접 import + `new Request(...)`.
9. `POST /api/stop`이 소유권 불일치에 409로 응답하고 fence를 **남긴다**.
10. `ServiceOwnershipError`가 `isServiceOwnershipError`로 판별되고, 일반 정지 실패는 판별되지
    않는다(오분류로 teardown을 통째로 막지 않도록).

## 게이트

`bun test tests/grok-lifecycle.test.ts tests/service.test.ts` → 전체 `bun run test`.
