# 260725 버그 스윕 — 미해결 비-GUI 버그 다중 PABCD 로드맵

## 목표

GUI·enhancement를 제외한 미해결 버그 이슈를 `codex/260725-bug-sweep` 워크트리에서
직접 수정한다. 각 이슈는 독립 work-phase = 독립 PABCD 사이클이며, work-phase마다
로컬 커밋을 쌓아 올린다.

- 워크트리: `/Users/jun/.codex/worktrees/404d/opencodex`
- 브랜치: `codex/260725-bug-sweep` (`origin/dev` = `f77e3963` 기준)
- goalplan: `.codexclaw/goalplans/opencodex-codex-260725-bug-sweep-gui-enhancement/`

## 제약

- `gui/`, `docs-site/`, `scripts/release.ts`, `.github/workflows/`는 범위 밖.
- 인증·크리덴셜 저장 경계 변경은 UNSAFE로 분류하고 사용자 판단을 받는다.
- 기존 열린 PR(#436 #430 #408 #376 #370) 브랜치를 직접 건드리지 않는다.
- `git push`는 사용자 명시 승인 전까지 금지. 로컬 커밋만 쌓는다.

## 대상 이슈와 배제 근거

| 이슈 | 증상 | 수정 여부 |
|---|---|---|
| #433 | 먼 미래 resetAt로 quota cooldown이 최대 24h 고착, 재시작만이 해제 수단 | WP1에서 수정 |
| #432 | Task Scheduler XML이 기본값을 생략하면 정상 서비스를 stale/AT RISK로 오판 | WP2에서 수정 |
| #422 | API-key `openai-responses`에서 remote compaction v2 fatal | WP3에서 수정 |
| #373 | Cursor 재시작 후 checkpoint 부재로 `inputTokens=0` 보고 | WP4에서 수정 |
| #404 | 혼합 게이트웨이에서 provider 단위 adapter 고정으로 hosted web_search 소실 | WP5에서 수정 |
| #435 | malformed content block 크래시 | 배제 — PR #436이 이미 커버, CI green |
| #420 | Anthropic 400 `text.text` Field required | 배제 — PR #430이 이미 커버 |
| #418 | V2 custom→custom 위임 실패 | 배제 — 제보자가 provider 비공개, 재현·귀속 미증명 |
| #417 #241 | 한국어 realtime U+FFFD, Desktop model picker | 배제 — upstream-tracking, ocx 밖 원인 |

## 의존성 순 work-phase 맵

효과 크기가 아니라 코드 결합도 순으로 배열한다. WP1·WP2는 서로 독립이고 다른 어떤
phase도 소비하지 않는 잎(leaf) 수정이므로 먼저 처리한다. WP3와 WP5는 둘 다
`src/server/adapter-resolve.ts`와 `responses/core.ts`의 분기를 건드리므로 반드시
WP3 → WP5 순서로 직렬화한다. WP4는 Cursor 어댑터 내부에만 갇혀 있어 어디에도
의존하지 않는다.

```
WP0 (docs)
  ├─ WP1  #433  src/codex/routing.ts            (독립)
  ├─ WP2  #432  src/service.ts                  (독립)
  ├─ WP3  #422  adapter-resolve + core + compact ─┐ 같은 파일 충돌
  │                                                │ → 직렬
  ├─ WP5  #404  adapter-resolve + core           ─┘
  ├─ WP4  #373  src/adapters/cursor/*            (독립)
  └─ WP6  전체 스위트 회귀 검증
```

실행 순서는 WP1 → WP2 → WP3 → WP4 → WP5 → WP6이다. WP4를 WP3과 WP5 사이에 두어
같은 파일을 연속으로 고치며 생기는 실수를 줄인다.

## 문서 맵

| 문서 | 대상 |
|---|---|
| `010_wp1_quota_cooldown_433.md` | #433 |
| `020_wp2_windows_scheduler_432.md` | #432 |
| `030_wp3_compaction_capability_422.md` | #422 |
| `040_wp4_cursor_context_estimate_373.md` | #373 |
| `050_wp5_model_adapter_override_404.md` | #404 |
| `060_wp6_sweep_closeout.md` | WP6 종료 요약 (WP6에서 작성) |

## 검증 계약

각 work-phase는 다음을 모두 만족해야 D로 닫힌다.

1. 해당 decade 문서의 stale 체크 및 필요한 경우 개정
2. 실제 코드 수정 diff
3. 버그를 재현하는 신규 회귀 테스트 (수정 전 실패 논증 포함)
4. `bun run typecheck` 종료코드 0
5. 해당 테스트 파일 `bun test` 통과
6. 로컬 커밋 1개 이상

WP6에서 `bun run test` 전체 스위트를 실행해 기존 테스트 회귀가 없음을 확인한다.

## 기준선

`bun install` 후 측정한 사전 상태:

```
bun test tests/codex-routing.test.ts
59 pass / 0 fail
```
