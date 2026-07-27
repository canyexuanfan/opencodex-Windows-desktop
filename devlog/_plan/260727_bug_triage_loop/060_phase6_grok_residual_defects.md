# 060 — WP5: #511 잔여 결함 판정

근거: `004_grok_orphan_adjacency_defect.md`, WP2 A단계 감사
대상: WP2에서 범위 밖으로 미룬 3건 + EOF 경계 1건

모두 **재현으로 확인**했다. 판정과 수정 방향까지가 이 phase의 범위이며, 구현은 각각
독립 결정이 필요해 착수하지 않는다.

## 1. 문서가 안내하는 수동 레시피가 삭제된다 (High)

`docs-site/src/content/docs/guides/grok-build.md:78-88`이 사용자에게 이렇게 안내한다:

> If you manage `~/.grok/config.toml` yourself — or opencodex is on a non-loopback bind —
> add per-model tables with **direct fields**, outside the `# >>> opencodex managed block` markers:
>
> ```toml
> [model.ocx-opus]
> model = "anthropic/claude-opus-4-8"
> base_url = "http://127.0.0.1:10100/v1"
> api_backend = "chat_completions"
> api_key = "opencodex-loopback"
> ```

이 형태가 정확히 sweep의 소유권 조건이다: 평범한 `[model.x]` 헤더 + `api_key`가
`opencodex-loopback` + loopback `base_url`. 문서를 그대로 따른 사용자의 설정이 다음
sync에 삭제된다.

재현:

```
문서 레시피 테이블 생존: false
남은 model 테이블: [model.ocx-gpt-5-6-sol]
```

소유권 판정식 자체는 의도대로 동작한다. 문제는 **우리가 사용자에게 우리 소유 표식을
직접 쓰라고 시켰다는 것**이다. 외부 모델에 대한 오탐이 아니라, 우리가 시켜서 만든
테이블에 대한 정탐이다.

### 수정 방향

두 갈래이며 어느 쪽이든 한쪽만 골라야 한다.

- **문서를 고친다.** 수동 레시피가 `api_key = "opencodex-loopback"`을 쓰지 않도록 바꾼다.
  가장 단순하지만, 이미 그 문서를 따른 사용자의 설정은 여전히 지워진다.
- **판정식에 변별자를 넣는다.** 관리 블록이 생성하는 엔트리에만 있는 표식(예:
  `extra_headers`의 `x-opencodex-grok`)을 추가 조건으로 요구한다. 기존 사용자를 보호하지만
  판정식이 복잡해지고, 낡은 자동 생성 엔트리가 그 표식을 안 가질 수 있다.

후자가 안전하나 검증 부담이 크다. 문서와 코드가 같은 계약을 말하도록 만드는 것이
본질이므로, 선택은 그 계약을 어디에 둘지의 문제다.

## 2. `ocx stop` 후 `default`가 사라진 테이블을 가리킨다 (Medium)

inject가 orphan을 채택해 삭제한 뒤 `stripGrokConfig`가 관리 블록을 걷어내면, `default`가
가리키던 별칭이 파일에서 사라진다.

재현:

```
[strip 후] default=ocx-gpt-5-6-sol / 존재 테이블=(없음) / dangling=true
```

inject는 살아남은 별칭으로 `default`를 재지정하지만, strip은 그 반대 작업을 하지 않는다.
`ocx stop` 이후 Grok은 존재하지 않는 모델을 기본값으로 들고 있게 된다.

**선재 결함이며 WP2 클램프가 악화시키지 않았다.** WP2 이전에도 SEPARATED 레이아웃에서
동일하게 발생했다. 다만 클램프로 ADJACENT 레이아웃이 정상 수렴하게 되면서, 예전에는
fence 손상에 먼저 부딪히던 경로가 이제 여기까지 도달한다.

### 수정 방향

`stripGrokConfig`가 블록을 제거할 때 `default`(및 `fork_secondary_model`)가 제거 대상
별칭을 가리키면 함께 정리한다. 다만 "무엇으로 되돌릴지"가 자명하지 않다 — 원래 사용자
값은 이미 유실됐을 수 있다. 백업 파일에서 복원하는 방안이 있으나 strip의 계약을 넓힌다.

## 3. fence 아래 마지막 orphan이 뒤따르는 주석을 삼킨다 (Medium)

orphan이 파일의 마지막 테이블이면 span이 EOF까지 간다. 그 뒤의 사용자 주석이 함께
삭제된다.

재현:

```
[EOF 주석] 생존: false
```

뒤따르는 것이 **테이블**이면 안전하다(다음 헤더에서 끊긴다). 주석과 자유 텍스트만
위험하다.

**선재 결함이며 WP2 클램프와 무관하다.** 클램프는 fence 위쪽 경계만 다룬다. 현재
코드와 모든 수정 변형이 동일하게 삭제한다.

### 수정 방향

EOF 쪽에도 상한이 필요하다. orphan 본문의 끝을 "다음 헤더 또는 EOF"가 아니라 "마지막
키=값 줄 다음"으로 잡으면 뒤따르는 주석이 보존된다. TOML 파싱 정밀도가 올라가야 하므로
범위가 작지 않다.

대안은 백업에 의존하는 것이다. WP2에서 `orphans.length > 0`일 때도 백업하도록 넓혔으므로
삭제된 주석은 `config.toml.bak-opencodex`에 남는다. 완전한 해결은 아니지만 복구 경로는
존재한다.

## 4. 낡은 `-2` 별칭 잔재 (Low, 미확인)

WP2 감사가 제기한 항목 중 재현하지 않은 것: 주석 꼬리(`api_key = "opencodex-loopback" # ours`)나
작은따옴표 리터럴이 `tableBodyKeys`를 통과하지 못해 영구 `-2` 중복을 만든다는 지적.

Grok이 파일을 재직렬화할 때 이런 형태를 만들 수 있다는 것이 근거였다. 실제로 그러는지
확인하지 않았으므로 **미확인 상태로 기록**한다. 확인 없이 판정식을 넓히면 오탐 위험만
커진다.

## 종합 판정

| # | 심각도 | 상태 | 이번 루프 조치 |
|---|--------|------|----------------|
| 1 | High | 재현됨 | 판정만 — 문서/코드 계약 결정 필요 |
| 2 | Medium | 재현됨 | 판정만 — strip 계약 확장 결정 필요 |
| 3 | Medium | 재현됨 | 판정만 — TOML 파싱 정밀도 문제 |
| 4 | Low | 미확인 | 기록만 |

1번이 가장 시급하다. 사용자가 우리 문서를 따랐다는 이유로 설정을 잃는 것은 신뢰 문제다.
다만 수정 방향 선택(문서 vs 판정식)이 제품 계약을 정하는 일이라 단독으로 결정하지 않는다.

2·3번은 선재 결함이고 WP2가 악화시키지 않았음을 확인했다. 백업 확대(WP2)로 최소한의
복구 경로는 생겼다.
