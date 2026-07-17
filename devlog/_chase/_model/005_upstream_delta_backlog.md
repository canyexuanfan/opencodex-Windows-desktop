# 005 — Upstream model/provider delta backlog

> Re-triaged: 2026-07-17 against OpenCodex `31fabf96`

초기 후보는 jawcode의 로컬 미커밋 `struct_har/chase/model/005_upstream_model_delta.md`와 `006_cross_project_patch_plan.md`에서 가져왔다. 그 문서가 참조한 GJC/OMP range는 2026-07-09 시점이므로, 아래 항목은 구현 전에 source commit과 현재 upstream HEAD를 다시 확인한다.

## 현재 분류

| 항목 | 상태 | 현재 OCX 근거 | 다음 행동 |
|---|---|---|---|
| Fugu/Sakana `fish_` login | `OPEN` | registry, OAuth, tests에서 `fugu|sakana|fish_` 구현이 없음 | OCX proxy 수요와 API 계약부터 확인. 이름만 보고 generic key provider로 추가하지 않는다. |
| Z.AI weekly-limit taxonomy | `PARTIAL` | `zai` registry/model metadata는 있음 (`src/providers/registry.ts:556`). exact weekly-exhaustion classifier는 없음 | 실제 Z.AI error body를 확보해 provider-scoped 분류가 필요한지 결정한다. |
| Cursor client-version 통일 | `OPEN` | discovery는 `cli-2026.02.13-41ac335` (`live-models.ts:20`), transport는 `cli-2026.07.08-0c04a8a` (`live-transport.ts:56`)로 갈라져 있음 | 공용 owner를 만들고 discovery/transport focused test로 고정한다. |
| OpenAI/Azure bounded 429 retry | `PARTIAL` | generic retry는 429를 의도적으로 제외하고, key pool은 429 회전을 지원한다. Kiro/Google은 별도 retry 정책이 있다. | SDK식 429 재시도를 통째로 복사하지 말고 provider별 terminal/quota 계약을 비교한다. |
| OpenCode Go/Kimi request compatibility | `VERIFIED` 기반, delta 확인 필요 | OpenCode Go MiniMax wire override, Kimi bracket-strip/parameter restrictions, live metadata 보강이 이미 있음 | 새 upstream commit의 request-shape 차이만 대조한다. |
| Anthropic disabled-thinking omission | `PARTIAL` | reasoning metadata와 Anthropic adapter 경로는 있으나 jawcode commit의 exact payload 조건은 이 문서화 pass에서 증명하지 않음 | focused payload test로 현재 wire를 먼저 캡처한다. |
| LiteLLM rich/vision metadata 보존 | `PARTIAL` | keyless/self-hosted route와 live discovery는 있음. parser는 context, reasoning boolean, vision boolean을 읽지만 임의 rich metadata를 보존하지 않음 (`src/codex/catalog.ts:990-1124`) | OMP가 보존하는 필드와 Codex가 실제 소비하는 필드의 교집합을 정한다. |
| Codex credential rotation/self-heal | `VERIFIED` 기반, delta 확인 필요 | multi-account affinity, cooldown, generation-safe OAuth persist가 이미 별도 구현됨 | OMP 변경을 auth/account outcome 단위로 비교하고 중복 추상화를 피한다. |
| response terminal/replay 호환 | `PARTIAL` | Responses parser/bridge에 기존 terminal handling이 있으나 OMP `response.done`, Anthropic replay commit과 line-by-line 대조하지 않음 | `src/responses/`, `src/adapters/openai-responses.ts`, Anthropic replay test를 함께 비교한다. |

## 우선순위

### Tier 1 — 작고 명확한 drift

1. Cursor client-version 공용화.
2. LiteLLM metadata field diff와 소비자 확인.
3. Z.AI weekly-limit 실제 error fixture 확보 및 분류 결정.

### Tier 2 — provider 정책 비교

4. OpenAI/Azure 429 terminality와 key/account failover 경계.
5. Anthropic disabled-thinking payload parity.
6. response terminal/replay parity.

### Tier 3 — 제품 결정이 먼저인 항목

7. Fugu/Sakana를 OCX built-in provider로 둘지 결정.
8. jawcode native provider 변화의 sibling sync를 자동화할지 결정.

## 갱신 절차

1. jawcode `struct_har/chase/model/005_upstream_model_delta.md`의 source range와 현재 HEAD를 확인한다.
2. candidate commit의 실제 diff를 연다. commit 제목만으로 import하지 않는다.
3. OCX owner를 registry, auth, router, adapter, catalog, docs-only 중 하나로 분류한다.
4. 현재 focused test가 이미 같은 계약을 증명하는지 먼저 찾는다.
5. 구현하거나 `REJECT` 근거를 남기고 이 표의 상태를 갱신한다.

## 재검증 검색

```bash
rg -n -i "fugu|sakana|fish_|weekly limit|client-version|litellm|response.done|thinking.*disabled" src tests
rg -n "isTransientUpstreamStatus|rotateKeyOn429|CURSOR_DISCOVERY_CLIENT_VERSION|CURSOR_CLIENT_VERSION" src tests
git -C ../jawcode status --short struct_har/chase/model
git -C ../jawcode log -1 --oneline
```
