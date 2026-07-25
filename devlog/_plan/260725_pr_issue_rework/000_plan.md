# 260725 PR/이슈 rework 통합 — 로드맵

## 목표

열린 PR 중 **우리가 직접 결함을 고쳐 통합할 수 있는 8건**을 dev에 올리고, 대응 이슈와 PR을
근거 코멘트와 함께 닫는다. 보안 경계 PR과 분할이 필요한 대형 PR은 병합하지 않고 구체적인
리뷰 코멘트만 남긴다.

## 착수 시점 사실

- 작업 워크트리: `/Users/jun/.codex/worktrees/ebcd/opencodex` (브랜치 `dev`)
- `dev` = `origin/dev` = `037e8f5e4fa32a82e4149acc509554f157656dad`
- 직전 버그 스윕(`260725_bug_sweep`)이 13:24에 종료되어 #433/#432/#422/#404와 PR #376이 closed.
- 로컬 게이트 기준선(`a5ec15e3`, 소스 동일): `bun run typecheck` exit 0,
  `bun run test` 4151 pass / 0 fail (324 파일), `bun run privacy:scan` 통과,
  `bun run lint:gui` exit 0.
- 이 워크트리는 처음에 의존성이 없었다. `bun install`(루트)과 `gui`에서의 `bun install`을
  먼저 실행해야 게이트가 돌아간다.

## 제약

- 브랜치 정책: feature 작업은 `dev`를 향한다. `main` 승격과 릴리스 자동화는 이 유닛의 범위 밖이다.
- 런타임은 Bun 네이티브다. Node 전용 API나 컴파일 단계 가정은 금지.
- `src/` 동작 변경에는 해당 서브시스템 근처의 회귀 테스트가 필요하다.
- `bun run privacy:scan`은 항상 통과해야 하고, 요청 본문·API 키·계정 식별자 로깅을 추가하지 않는다.
- 보안 경계(인증, credential/token, OAuth, GitHub Actions, 릴리스 자동화, 의존성 설치)는
  `MAINTAINERS.md`상 명시적 보안 리뷰 대상이다. 이 유닛은 그 범위를 병합하지 않는다.
- `devlog/`는 gitignore 대상이므로 문서 추가는 `git add -f`가 필요하다.

## 조사 근거

이 로드맵은 열린 PR 22건과 이슈 27건에 대한 병렬 코드 감사에서 나왔다. 판정 요약:

| 분류 | PR | 근거 |
|---|---|---|
| 결함 없음, 즉시 통합 | #430, #439 | 리뷰에서 merge-blocking 결함 미발견 |
| 우리가 고쳐서 통합 | #436, #370, #449, #427 | 각 1~2개의 구체적 결함 확인 |
| rebase + 게이트만 | #389, #385 | 기존 리뷰 지적 전부 해결됨 |
| 보안 리뷰 필요, 병합 보류 | #408, #424, #447, #445, #355 | 권한 상승, SSRF, OAuth/credential 경계 |
| 분할/재작업 요청 | #434, #405, #429, #391 | 96파일 혼재, 포함 관계, stale, fire-and-forget |
| 이미 종료 | #376 | dev `28066934`가 #373을 더 완전하게 해결 |

dev에 **실제로 살아있는** 버그로 코드 확인된 것은 두 건이다.

- #435 — `src/responses/parser.ts:30`, `:59`가 raw block을 무검증 cast한다. `[null]` 입력 시
  `block.type` 접근에서 throw한다.
- #420 — `src/adapters/google.ts:103`이 text를 검증하지 않고 전송하고, `:123`이 빈 assistant
  `parts`를 전송한다.

## work-phase 맵 (dependency-ordered)

순서는 일정이 아니라 의존 구조다. 앞 단계의 검증된 출력이 다음 단계의 입력이 된다.

```
WP0 (docs)
 └─ WP1 #430 google parts ──┐
                            ├─ WP2 #436 parser (WP1의 빈 parts 방어에 의존)
 WP3 #439 kiro ─────────────┘
 WP4 #370 auth ── WP5 #389 model visibility ── WP6 #449 gui workspace ── WP7 #427/#385
                                                                              └─ WP8 병합/CI/close
```

| WP | 대상 | 문서 | 우리가 고칠 결함 |
|---|---|---|---|
| WP0 | 로드맵 | `000`~`080` | — (docs-only) |
| WP1 | PR #430 (#420) | `010` | 없음. 테스트 2케이스 보강 |
| WP2 | PR #436 (#435) | `020` | parser 가짜 콘텐츠 마커 |
| WP3 | PR #439 | `030` | 없음 |
| WP4 | PR #370 | `040` | auth-api transient null 캐시 파괴 |
| WP5 | PR #389 | `050` | 없음. rebase + 게이트 |
| WP6 | PR #449 (#448) | `060` | provenance 추론 오분류, Add 영구 비활성 |
| WP7 | PR #427 + #385 | `070` | 단위 표기(KB→KiB), discovery 테스트 부재 |
| WP8 | 병합·CI·close | `090` (영수증) | — |

**WP1 → WP2 순서는 강제다.** #436을 단독 적용하면 malformed content가 `[]`로 정규화되는데,
현재 dev의 Google adapter는 빈 배열을 그대로 빈 `parts`로 전송하므로 #420이 재발한다.
#430이 먼저 들어가야 이 경로가 막힌다.

## 알려진 상호 충돌

- **#447 ↔ #439**: `src/adapters/kiro.ts`와 `src/types.ts`의 `createKiroAdapter` 영역이 겹친다.
  포함 관계는 없다. WP3에서 #439가 먼저 들어가므로 #447은 이후 rebase 대상이 된다.
- **#434 ⊃ #405**: `derive.ts`, `free-directory.ts`, `registry.ts`, parity test의 최종 blob이 동일하다.
- **#424 ↔ #355**: 둘 다 `src/images/artifacts.ts`를 신규 생성하며 `materializeInlineImage`
  시그니처가 호환되지 않는다. 포함 관계 없음.
- **#385 ↔ #405/#434**: `src/providers/registry.ts`와 parity test가 겹친다. 어느 쪽이 먼저 들어가도
  작은 rebase가 필요하다.
- **#445 ↔ #449**: 공유 파일 0개. 상호 충돌 없다.

## Verifier

각 구현 work-phase의 C는 다음을 실제로 실행하고 출력을 영수증에 남긴다.

```bash
bun run typecheck        # exit 0
bun run test             # 0 fail
bun run privacy:scan     # 통과
bun run lint:gui         # exit 0
```

GUI가 바뀐 work-phase는 추가로:

```bash
cd gui && bun test tests && bun run build
```

WP8은 exact-SHA hosted `Cross-platform CI`와 `Service lifecycle`이 둘 다 success여야 닫힌다.
선행 SHA의 성공은 후행 커밋의 증거가 아니다.

## Stop condition

8개 PR의 변경이 `dev`에 병합되어 로컬과 `origin/dev` SHA가 일치하고, 병합 SHA의 두 hosted
게이트가 success이며, 병합된 PR과 대응 이슈(#420, #435, #448)가 근거 코멘트와 함께 closed이고,
보류 대상 PR 9건에 구체적 리뷰 코멘트가 게시된 상태.

## Terminal outcomes

- `DONE` — 위 Stop condition 충족.
- `NOOP` — 해당 PR이 이미 dev에 반영되어 코멘트 후 close만 남은 경우.
- `BLOCKED` — 원격 거부, 같은 실패의 CI 3회 연속, 또는 원저자 의도 없이 해석 불가한 conflict.
- `UNSAFE` — 진행에 보안 경계 PR 병합이 필요해진 경우. 중단하고 사용자 승인을 받는다.
- `NEEDS_HUMAN` — 결함 수정 방향이 원저자 설계 의도와 충돌해 판단이 필요한 경우.

## Escalation

통합 충돌이나 신규 회귀는 main session이 회수한다. 보안 경계 판단과 provider 신뢰 표현
(#385 BizRouter 등록 등)은 자동 결정하지 않고 사용자에게 되돌린다.
