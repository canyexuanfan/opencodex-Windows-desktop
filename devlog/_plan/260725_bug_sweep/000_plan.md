# 260725 버그 스윕 — 미해결 비-GUI 버그 다중 PABCD 로드맵

> 개정 이력: r1은 A-gate에서 FAIL(blocker 12건). r2에서 연구 자료를 `001`로 분리하고
> (LEXICO-SPLIT-01), WP1을 probe lease 설계로 교체하고, WP6 문서를 작성하고,
> 의존성 맵을 실제 공유 지점으로 정정했다.

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

효과 크기가 아니라 코드 결합도 순으로 배열한다.

실제 공유 지점(A-gate에서 정정):

- **WP3 ∩ WP5 = `src/server/responses/core.ts` + `src/server/responses/compact.ts`.**
  r1은 이를 `adapter-resolve.ts` 충돌로 잘못 적었다. WP3는 `adapter-resolve.ts`를
  건드리지 않고 capability gate를 `openai-tiers.ts`에 추가하며, WP5는
  `adapter-resolve.ts`와 `compact.ts`를 모두 수정한다. 충돌의 실체는 두 phase가
  같은 두 파일의 **분기 의미**를 바꾼다는 semantic dependency다.
- WP3가 `compact.ts:205`의 native gate를 교체하고, WP5가 그 위에 effective adapter
  판단을 얹는다. 따라서 WP3 → WP5 순서가 강제된다.
- **WP1 ∩ 없음.** `src/codex/routing.ts` + `auth-context.ts`만 건드린다.
- **WP2 ∩ PR #408.** 파일 충돌은 없지만 #408 최신 head가 `src/service.ts`를 크게
  바꿨으므로 착수 시 대조가 필요하다 (020 문서 참조).
- **WP4 ∩ 없음 (단, 조건부).** Cursor 어댑터 내부로 한정하되, 공유
  `src/lib/token-estimate.ts`는 **건드리지 않는다**. r1은 여기에 `"grok"` prefix를
  추가하려 했으나 그 함수는 `kiro.ts`, `claude-messages.ts`, `chat-completions.ts`가
  함께 쓴다. Grok 비율은 Cursor 국소 helper로 가둔다 (040 문서 참조).

```
WP0 (docs)
  ├─ WP1  #433  codex/routing.ts + auth-context.ts       (독립)
  ├─ WP2  #432  service.ts                               (독립, PR #408 대조 필요)
  ├─ WP3  #422  openai-tiers + core.ts + compact.ts ─┐
  │                                                   │ semantic dependency → 직렬
  ├─ WP5  #404  adapter-resolve + core.ts + compact.ts┘
  ├─ WP4  #373  adapters/cursor/*  (shared estimator 불가침)
  └─ WP6  전체 스위트 회귀 검증 + 보안 경계 재확인
```

실행 순서는 WP1 → WP2 → WP3 → WP4 → WP5 → WP6이다. WP4를 WP3과 WP5 사이에 두어
같은 파일을 연속으로 고치며 생기는 실수를 줄인다.

## 문서 맵

| 문서 | 대상 |
|---|---|
| `001_external_evidence.md` | 공식 문서 근거, 경쟁 PR 현황, 기준선 (연구) |
| `010_wp1_quota_cooldown_433.md` | #433 |
| `020_wp2_windows_scheduler_432.md` | #432 |
| `030_wp3_compaction_capability_422.md` | #422 |
| `040_wp4_cursor_context_estimate_373.md` | #373 |
| `050_wp5_model_adapter_override_404.md` | #404 |
| `060_wp6_sweep_closeout.md` | WP6 통합 검증 절차 |

연구 자료(공식 문서 조사, 경쟁 PR 이력, 기준선)는 `001`에 모으고, `010`~`060`은 결정과
diff, accept criteria만 담는다 (LEXICO-SPLIT-01).

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

`001_external_evidence.md` §기준선 측정 참조.

## 보안 검토 대상

`MAINTAINERS.md` 기준으로 WP1(계정 차단 의미)과 WP5(adapter override의 크리덴셜 경계)가
명시적 검토 대상이다. 각 문서에 확인 항목을 적었고 WP6에서 재점검한다.
