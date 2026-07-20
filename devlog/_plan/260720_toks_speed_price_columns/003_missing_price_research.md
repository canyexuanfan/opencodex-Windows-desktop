# 003 — 빈 가격 조사 (Luna 스웜, 2026-07-20)

jawcode `models.json`에 없거나(all-zero 포함) alias가 없는 모델의 공식 단가 조사.
Luna 3레인(gpt-5.6-luna explorer, cxc-search 첨부) 결과를 메인이 검수해 정리.
표기: 4튜플 = (input, output, cacheRead, cacheWrite) USD / 1M tokens.
status: `verified`(공식 페이지 직접 열람) / `verified-derived`(suffix→기반 모델 등
유도 매핑, estimated 전파) / `unverified`(lead — 등재 금지) / `not-published`(공식 미공개).

**정책 연결(000 v2 로드맵)**: verified와 verified-derived만 expected 오버레이 테이블
(`src/usage/expected-prices.ts`, WP1)에 넣는다. not-published/unverified는
fail-closed `—`(resolver가 unverified를 반환하지 않음). 오버레이 값은 GUI에서 `~$` 접두 유지.

## 1. Verified — 오버레이 등재 가능

| provider | model | 4튜플 | 소스 | 비고 |
|---|---|---|---|---|
| minimax / minimax-cn | MiniMax-M2.1-highspeed | (0.60, 2.40, 0.03, 0.375) | platform.minimax.io/docs/guides/pricing-paygo (공식) | jawcode 미매칭 2쌍 해소 |
| google (antigravity/vertex 계열) | gemini-3.1-pro (≤200k) | (2, 12, 0.20, —*) | ai.google.dev/gemini-api/docs/pricing (2026-06-18 갱신) | *cache-storage는 시간당 과금이라 cacheWrite 튜플에 직접 매핑 불가 → cacheWrite=0 + 비고 |
| google | gemini-3.1-pro (>200k) | (4, 18, 0.40, —*) | 상동 | 구간별 가격 — 오버레이는 ≤200k 기준 채택, 비고에 구간 명시 |
| google | gemini-3.5-flash | (1.50, 9, 0.15, —*) | 상동 | extra-low/low/mid/high suffix는 기반 모델 가격으로 매핑(공식 명시 없음 → 비고 표기) |
| google | gemini-3-flash | (0.50, 3, 0.05, —*) | 상동 | gemini-3-flash-agent는 Agent API 과금 원칙상 기반 모델 가격 적용(공식 Billing FAQ) |
| deepseek | deepseek-chat | (0.27, 1.10, 0.07, 0) | api-docs.deepseek.com/quick_start/pricing-details-usd | 2026-07-24 V4 Flash alias 전환 예정 — 재검증 필요 비고 |
| deepseek | deepseek-reasoner | (0.55, 2.19, 0.14, 0) | 상동 | 상동 |
| xiaomi | MiMo-V2.5-Pro | (¥3, ¥6, ¥0.025, 0) CNY | mimo.mi.com/docs/news/billing | CNY → USD 환산 필요: 오버레이는 USD 고정이므로 환산율 명시 필요 → 보류(unverified-usd) |

## 2. Not published — 공식 미공개, 오버레이 불가 (`—` 유지)

| provider | models | 근거 |
|---|---|---|
| kimi / moonshot | k3, k3[1m], kimi-k2.7-code(-highspeed), kimi-k2.6, kimi-k2.5, kimi-for-coding | platform.kimi.ai/docs/pricing/* 페이지에 가격표 미표시 (공식 페이지 직접 열람). 구독(Kimi Code membership) quota 기반 |
| xai | grok-composer-2.5-fast | docs.x.ai/developers/pricing 미등재; Grok Build 무료 제공 발표(x.ai/news/composer-2-5) |
| openrouter | openai/gpt-5.6 | openrouter.ai/models에 해당 정확 ID 미등재 |
| google-antigravity | claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b-medium | Antigravity 구독 quota 포함 제공, 모델별 토큰 단가 미공개 (antigravity.google/pricing) |
| kimi-code | (kimi-for-coding 계열) | 구독 quota, API 단가 미공개 |

## 3. Unverified / 구조적 미확정 — 후속 재조사 대상

| provider | 상태 | 비고 |
|---|---|---|
| zai / GLM | unverified | z.ai 가격 URL 오류, bigmodel.cn 확정 불가 — 재조사 시 도메인 리다이렉트 추적 필요 |
| alibaba-token-plan | unverified | Token Plan 북경 전용 단가 공식 확인 불가 — Model Studio 일반 가격과 혼용 금지(메모리: 별도 제품 계약) |
| zenmux | 구조 다름 | flow/구독 quota 중심($20 Builder~), 모델별 토큰 정가표 없음. free 모델은 $0 실비 — "free" 라벨이 정직 |
| cerebras | unverified | 최신 공식 페이지가 PAYG 충전/Code 구독($50/24M/day) 중심, 모델별 단가표 비노출 |
| mistral | unverified | mistral.ai/pricing 페이지에서 모델별 수치 추출 실패(동적 렌더) — 브라우저 재조사 대상 |
| cursor | 구조 다름 | 구독+usage pool. MAX Mode만 provider API 정가 기준 — cursor 로그는 estimated usage라 어차피 ~$ |
| kiro | 구조 다름 | credit 단위($0.04/credit 초과분). 토큰 단가 등가 없음 — expected 환산 불가, `—` |
| github-copilot | 부분 가능 | AI Credits 1=$0.01 + 모델별 credit 환산표(docs.github.com) — 후속 재조사로 모델별 환산표 확보 시 오버레이 가능 |

## 4. 오버레이 등재 결정 (WP1 입력)

즉시 등재 **11쌍** (provider는 registry의 실제 로그 provider id — `google`이 아니라
`google-antigravity`; 010 §5 주석의 exact key 목록이 구현 SSOT):

- verified(4): `minimax`/`minimax-cn` × MiniMax-M2.1-highspeed,
  `deepseek` × deepseek-chat/deepseek-reasoner.
- verified-derived(7): `google-antigravity` × gemini-3.1-pro-low/high(기반 gemini-3.1-pro
  ≤200k), gemini-3.5-flash-extra-low/low/mid/high(기반 gemini-3.5-flash),
  gemini-3-flash-agent(기반 gemini-3-flash + Agent 과금 원칙).

suffix→기반 모델 매핑은 `status: "verified-derived"`로 구분(공식이 suffix 동일가를
명시하지 않음; estimate는 `estimated=true`로 전파).

보류(`—` 유지): Kimi 전 계열, grok-composer-2.5-fast, openrouter/openai-gpt-5.6,
Antigravity의 claude/gpt-oss, zai, alibaba-token-plan, cerebras, mistral, xiaomi(CNY),
kiro, github-copilot(환산표 미확보), gemini-pro-agent(모델 ID 자체 미확인),
gemini-3-pro(가격표에 별도 항목 없음 — 3.1-pro와 동일시 금지).

비율로 보면: 미매칭 26쌍 + all-zero 3쌍 중 이번 조사로 verified 오버레이 가능
**11쌍**(verified 4 + verified-derived 7), 나머지는 not-published/unverified로 fail-closed.

## 5. 재조사 백로그

1. mistral/cerebras/zai — 브라우저 렌더 기반 재조사 (Luna 텍스트 추출 한계).
2. github-copilot 모델별 credit 환산표 파싱.
3. deepseek 2026-07-24 V4 Flash 전환 후 가격 재확인.
4. xiaomi CNY→USD 환산 정책 결정(환산율 고정 vs 미등재).
