---
created: 2026-07-26
status: plan
phase: wp2
blockers: [B1]
tags: [grok-build, auth, non-loopback, security]
---

# 020 — 비루프백 인증 (B1)

대상 파일: `src/grok/inject.ts`, `src/grok/sync.ts`, `tests/grok-config-inject.test.ts`,
`tests/grok-sync.test.ts`.
근거: `000_blocker_inventory.md` B1, `001_grok_source_evidence.md` E3.

## 문제 재정의

리뷰어들은 "비루프백에서는 자동 등록을 거부하라"고 제안했다. 그 제안의 전제는
**설정 파일에 실토큰을 쓰는 것 외에 방법이 없다**는 것이었다. 원본 확인 결과 그 전제가 틀렸다:
grok은 `env_key`로 환경변수 이름만 적어두면 요청 시점에 토큰을 읽는다(E3).

따라서 본 계획은 지적의 **의도**(사용자 실토큰을 우리가 덮어쓰지 않는다, 작동하지 않는 설정을
말없이 남기지 않는다)를 그대로 만족시키되, 기능을 잘라내지 않는 방식을 택한다.

## 설계

### 1. 루프백 판정을 공유 가능한 곳으로

`src/codex/inject.ts`의 `isLoopbackHostname`은 모듈 private이고, 같은 이름이 `auth-cors.ts`에
또 export되어 있으며 `service.ts`에 사본이 하나 더 있다. 새 사본을 만들지 않는다.
`src/codex/inject.ts`에서 `isLoopbackHostname`을 **export**하고 grok 모듈이 그것을 쓴다.
(`providerBaseHost`는 `0.0.0.0`을 `127.0.0.1`로 접는 다이얼 주소 매퍼라 판정에 쓸 수 없다.)

### 2. 블록 생성의 인증 필드 분기

`buildGrokManagedBlock(port, models, hostname, reservedAliases)`에서:

```ts
const nonLoopback = !isLoopbackHostname(hostname);
// 루프백: 데이터 플레인이 열려 있으므로 자리표시자 키로 충분하다.
// 비루프백: 실토큰이 필요하지만 사용자 파일에 비밀을 쓰지 않는다 — grok이 실행 환경에서
// 읽도록 env_key만 남긴다(미설정 시 grok은 키 없이 호출해 401로 드러난다).
...(nonLoopback
  ? [`env_key = ${tomlString(API_AUTH_TOKEN_ENV)}`]
  : ['api_key = "opencodex-loopback"']),
```

`API_AUTH_TOKEN_ENV`는 `"OPENCODEX_API_AUTH_TOKEN"` — `auth-cors.ts`가 요구하는 바로 그 변수명이며
이미 상수화되어 있으면 재사용하고, 아니면 한 곳에서 export한다.

`api_key`를 아예 방출하지 않는 것이 중요하다. E3의 우선순위상 비어 있지 않은 `api_key`가
`env_key`를 가리기 때문이다.

### 3. 사용자가 손으로 넣은 키를 우리가 지우지 않는다는 보장

관리 블록은 마커 사이만 재생성하므로 fence 밖 사용자 `[model.*]`는 이미 보존된다(B3 예약 로직).
비루프백에서 우리 블록이 더 이상 리터럴 키를 쓰지 않으므로, 메인테이너가 재현한
`REAL_TOKEN_PRESERVED=false` 시나리오 자체가 성립하지 않는다.

### 4. 사용자에게 상태를 알린다

`GrokInjectResult.message`에 비루프백 모드임을 명시한다:

```
Added the opencodex managed block to Grok config (non-loopback bind: models read
OPENCODEX_API_AUTH_TOKEN from the environment — export it where you run `grok`).
```

CLI는 이미 `r.message`를 출력하므로 별도 배선이 필요 없다.

## 회귀 테스트

`tests/grok-config-inject.test.ts`:
1. `hostname: "0.0.0.0"` → 블록에 `env_key = "OPENCODEX_API_AUTH_TOKEN"`이 있고
   `api_key`가 **없다**.
2. `hostname: "192.168.1.10"` → 동일 + `base_url`이 `http://192.168.1.10:<port>/v1`.
3. `hostname` 미지정/`127.0.0.1`/`localhost`/`::1` → 기존대로 `api_key = "opencodex-loopback"`,
   `env_key` 없음.
4. 비루프백 결과 메시지에 환경변수 이름이 포함된다.

`tests/grok-sync.test.ts`:
5. 비루프백 hostname으로 `syncGrokConfig`를 **두 번** 실행해도 사용자가 fence 밖에 둔
   `[model.mine] api_key = "real-token"`이 바이트 그대로 남는다 (B1 재현의 반증).

## 게이트

`bun test tests/grok-config-inject.test.ts tests/grok-sync.test.ts` → `bun run typecheck`.
