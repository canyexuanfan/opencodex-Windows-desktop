# 000 — 버그 묶음 해결 유닛 계획

세션: `019fa53a-5c95-76d1-b616-faab73d044e2`
goalplan: `opencodex-bug-pr-6-7-pabcd-work-phase-wp1-docs-f`
기준: `origin/dev` = `f195e90bc`, 로컬 `dev` = `c17f51659`(미푸시 2건)
작성: 2026-07-28 (WP1 docs-only 사이클)

## 목표

`bug` 라벨이 붙은 열린 PR 6건·이슈 7건 중 **우리가 실제로 닫을 수 있는 것**을
PABCD 다중 사이클로 해결한다. 사용자가 커밋·푸시·머지를 명시 승인했다.

## 선행 조사 (재작성 금지, 참조만)

| 문서 | 내용 |
| --- | --- |
| `260727_owner_decision_ledger/009_ssh_remote_proxy_rootcause.md` | SSH 원격 프록시 근본 원인 — `isLoopbackRequestHost` |
| `260727_owner_decision_ledger/010_bug_bundle_fixability.md` | 버그 13건 해결가능성 전수 판정 |
| `260727_owner_decision_ledger/007_delta_260728.md` | 원장 델타 + Mind 감사 정정 |

두 문서 모두 Mind 감사를 거쳤다. 이 유닛은 재조사하지 않고 **stale check 후 활용**한다.

## 제약

- 브랜치: PR은 `dev` 대상. `main` 직접 변경 금지 (AGENTS.md Branch policy).
- 검증: `bun run typecheck` + 대상 `tests/*.test.ts` 실제 실행 출력.
- 조건부 분기는 C-ACTIVATION-GROUNDING-01 — 분기를 실제로 발화시키는 테스트가
  있어야 하며 "전체 green"은 불충분.
- 프라이버시: `bun run privacy:scan` 초록 유지. 요청 본문·API 키·계정 식별자
  로깅 금지.
- 보존: 로컬 `dev`의 미푸시 커밋 2건(`c17f51659`, `446e27884` star prompt)과
  다른 worktree 10곳의 작업.

## 스코프 밖 (건드리지 않음)

| 항목 | 이유 |
| --- | --- |
| PR #429 | dev가 쓰는 `CODEX_SHELL_*` 심볼을 삭제 — 리베이스가 아니라 재구현 |
| PR #528 | #424 선행 필요 + SSRF급 P1 5건 |
| PR #447 | Kiro 인증 경계 설계급 결함 4건 |
| 이슈 #92 / #241 / #417 | 업스트림 차단 — 우리가 닫을 수 없음 |
| 이슈 #543 / #418 | 리포터 캡처 대기 |

## work-phase 맵 (의존성 순, PHASE-SPLIT-01)

순서는 노력가 아니라 **의존 구조**다. 서버 인증 게이트(WP2)가 가장 아래에
있고, 그 위에 어댑터/응답 계층(WP3·WP4)이 얹히며, PR 정리(WP5·WP6)는 코드
기반이 정리된 뒤에 온다.

| # | decade doc | 대상 | 계층 |
| --- | --- | --- | --- |
| WP2 | `010_ssh_loopback_gate.md` | SSH 원격 프록시 — `auth-cors.ts` | 서버 인증 게이트 (최하부) |
| WP3 | `020_tls_altname_diagnosis.md` | 이슈 #553 — `responses/core.ts` | 응답/오류 계층 |
| WP4 | `030_claude_system_dedup.md` | 이슈 #545 — `adapters/anthropic.ts` | 어댑터 계층 |
| WP5 | `040_pr527_rebase.md` | PR #527 리베이스+리타깃 | PR 정리 |
| WP6 | `050_pr557_boundary.md` | PR #557 머지 + #533 클로즈 | PR 정리 |

> goalplan의 wp2~wp6 번호와 decade doc 번호가 1:1 대응한다. 단 goalplan 초기
> 등록 순서(#527 먼저)는 **의존 순서로 재배열**됐다 — 로드맵 락은 이 문서다
> (LOOP-DOCS-FIRST-01: 초기 등록은 스켈레톤, 락은 docs-only D).

### 재배열 이유

초기 등록은 "기계 작업 먼저"라는 노력 기준이었다. PHASE-SPLIT-01은 이를
금지한다. 실제 의존은 이렇다:

- `auth-cors.ts`의 게이트는 `/v1/*` 전 경로가 통과하는 최하부다. 여기가 바뀌면
  그 위 계층의 테스트 전제가 바뀐다.
- `#553`(오류 메시지)과 `#545`(system 블록)는 서로 독립이지만 둘 다 게이트를
  통과한 뒤의 계층이다.
- PR #527/#557은 **우리 코드 변경이 없다**. 다른 사람의 diff를 정리하는
  일이므로 우리 변경이 다 끝난 뒤에 리베이스해야 재작업이 없다.

## 성공 기준

| id | 시나리오 | 증거 |
| --- | --- | --- |
| c1 | 이 유닛에 000 + 모든 decade doc이 diff-level로 존재하고 커밋됨 | `ls` + 커밋 해시 |
| c5 | 포트가 다른 루프백 Host가 게이트를 통과하고 비루프백은 여전히 거부 | 신설 테스트 출력 |
| c3 | `ERR_TLS_CERT_ALTNAME_INVALID`가 별도 메시지 + 복구 명령 | 분기 진입 assertion |
| c4 | 인바운드 system이 Claude Code 정체성을 가질 때 prepend 안 함 / 없을 때 함 | 양쪽 케이스 |
| c2 | PR #527이 base=dev, mergeable, enforce-target pass | `gh pr view` + `gh pr checks` |
| c6 | PR #557 머지 + #533 클로즈, 또는 NEEDS_HUMAN 기록 | `gh pr view --json state` |

## SoT 동기화 대상 (SOT-SYNC-01)

| 변경 | 패치할 SoT |
| --- | --- |
| WP2 원격 접근 | `docs-site/src/content/docs/reference/configuration.md` "Remote access" 절 |
| WP3 오류 메시지 | 해당 없음 (오류 문자열은 코드가 SoT) |
| WP4 어댑터 | `structure/` 내 anthropic 어댑터 불변식 문서가 있으면 확인 |

## 터미널 판정 기준

- `DONE` — 커밋 + 검증 증거 + 실제 상태 변화(PR 생성/머지, 이슈 클로즈)
- `BLOCKED` — 업스트림/리포터 등 외부 의존
- `NEEDS_HUMAN` — 보안 경계 판단 등 오너만 내릴 수 있는 결정
