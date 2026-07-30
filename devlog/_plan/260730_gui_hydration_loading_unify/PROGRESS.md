# 구현 진행 기록

유닛 `260730_gui_hydration_loading_unify`. 이슈 #753.
각 WP는 완전한 PABCD 사이클 하나이며, 종료 시 로컬 커밋 하나를 남긴다.

## 사용자 정정 (2026-07-30)

최초 리서치는 탭 전환 시 82ms 빈 창에 초점을 맞췄다. 사용자가 정정했다.

> "지금 불러와지는건 정상이고 그 전역설치본도 지금 그게 너무느리게 로딩된다고
> 그래서 스피너를 도입하자는거고"

즉 기능 결함이 아니라 **느린 대기 구간이 보이지 않는 것**이 문제다. 실측
`?refresh=1` 908ms, 서버 콜드 경로 `8s × ceil(계정수/4)`. 이 정정이 WP2의 범위를
바꿨다 — 어댑터·프리미티브만으로는 계정 목록에 아무 변화가 없기 때문에
`useCodexAccountPool`까지 WP2에 포함됐다.

## WP2 — 로딩 계약 기반 (완료)

커밋 `ba3a29d32`. A 감사 5라운드(FAIL 4회 → PASS).

감사가 잡아낸 설계 결함과 반영:

| # | 결함 | 반영 |
|---|------|------|
| 1 | 어댑터만 추가하면 계정 목록에 변화 없음 (다른 훅이 소유) | `useCodexAccountPool`을 WP2 범위에 포함 |
| 2 | `loading-with-stale-data`가 죽은 코드 — 스토어가 데이터 있으면 `loading`을 안 올림 | 스토어에 `refreshing` 추가 |
| 3 | `enabled: false`가 영구 스켈레톤 | `disabled` 상태 추가 |
| 4 | `throw undefined` 판별 불가 | 스토어 경계에서 정규화 |
| 5 | `attemptsRef`를 렌더에서 읽음 | 메커니즘 폐기, `hasSucceeded`/`lastAttemptOk`를 스냅샷으로 |
| 6 | 라이브 리전 이중 알림 | `live` prop + 오류 배너 소유권 규칙 |
| 7 | 콜드 재시도가 정지 화면 | `retrying-cold` 추가, 인플라이트를 실패보다 우선 평가 |
| 8 | 계정 풀 `refreshing`이 겹친 요청에서 조기 해제 | 인플라이트 카운터 |
| 9 | `try/finally`가 `beginActiveRead()` throw 미포함 | `try`를 카운터 증가 직후로 |
| 10 | 점진 페인트 회귀 (`accountsOk && activeOk`로 바꿨던 것) | 원형 분기 보존 |

### 변경 파일

- `gui/src/client-resource.ts` — `refreshing` / `hasSucceeded` / `lastAttemptOk`.
  `loading`의 기존 의미("콘텐츠를 대체해도 됨")는 불변.
- `gui/src/data-surface.ts` (신규) — 8상태 분류 + `useDataSurface` 순수 어댑터.
- `gui/src/components/data-surface.tsx` (신규) — 스켈레톤·상태줄 프리미티브.
- `gui/src/styles.css` — 규칙 3개. `.spin`과 기존 shimmer 재사용, 신규 토큰 0개.
- `gui/src/hooks/useCodexAccountPool.ts` — 인플라이트 카운터 + `firstAttemptSettled`,
  컨트롤러에 `refreshing` / `initialLoading` 노출.
- `gui/src/components/CodexAccountPool.tsx` — 재검증 중 상태줄.
- 테스트 3파일 (신규 9건 + 추가 2건 + 계약 목록 2필드).

### 검증

```
bun run typecheck                 exit 0
(cd gui && bun run build)         tsc -b && vite build 성공
(cd gui && bun test tests)        410 pass / 0 fail / 1847 expect / 84 files
bun run lint:gui                  무경고
bun run privacy:scan              passed
```

활성화 증거 (도그푸딩 인스턴스, 포트 10199, 로컬 dev 빌드):

| 경로 | 관측 |
|------|------|
| 강제 새로고침 클릭 | 139–669ms 동안 `.data-surface-status` + `.spin` + `aria-busy=true`, 계정 행 유지, 800ms 해제 |
| 조용한 30초 폴링 (클릭 없음) | 지연 에뮬레이션(1200ms) 하에 18293ms 시점 `status=true spin=true busy=true`, 행 유지 |
| 겹친 요청 | 일반 load가 먼저 해제돼도 `refreshing` 유지, 강제 해제 후 false |
| 콜드 실패 | `initialLoading=false`, `loadState=error` — 무한 스켈레톤 없음 |

스크린샷: `.tmp/dogfood/shots/refresh-spinner.png` (추적 안 되는 스크래치 경로).

### 도그푸딩 셋업

처음에는 사용자의 상시 프록시(포트 10100)를 건드리지 않고 별도 인스턴스로 검증했다.

```bash
OPENCODEX_HOME=<repo>/.tmp/dogfood bun run src/cli/index.ts start --port 10199
```

`findGuiDist()`가 소스 위치 기준으로 dist를 찾으므로 이 인스턴스는 방금 빌드한
`gui/dist`를 서빙한다.

**이후 사용자 요청으로 전역 `ocx`를 로컬 트리 symlink로 전환했다.** 이제 포트 10100의
상시 서비스도 로컬 코드를 실행한다.

```bash
# 기존 npm 설치본을 보존
mv ~/.bun/install/global/node_modules/@bitkyc08/opencodex \
   ~/.bun/install/global/node_modules/@bitkyc08/opencodex.npm-2.7.43.bak

# 로컬 트리로 링크
ln -s /Users/jun/Developer/new/700_projects/opencodex \
      ~/.bun/install/global/node_modules/@bitkyc08/opencodex

ocx service stop && ocx service start
```

`~/.bun/bin/ocx`는 원래부터 그 패키지 경로를 가리키는 symlink이고 launchd plist도
`<pkg>/src/cli/index.ts`를 실행하므로, 패키지 디렉터리 하나만 바꾸면 CLI·서비스·GUI가
모두 로컬 소스를 쓴다. 되돌리려면 링크를 지우고 `.npm-2.7.43.bak`을 제자리로 옮긴다.

검증: `readlink -f ~/.bun/bin/ocx` → 로컬 `bin/ocx.mjs`,
`curl -s http://127.0.0.1:10100/ | rg -o 'assets/[^"]+'`가 로컬 `gui/dist` 해시와 일치,
서빙 중인 CSS에 `.data-surface-status` 규칙 존재.

## WP3 — 15표면 이관 (진행 중, 12/15)

`020_page_migration.md` 소비. 커밋 3개.

| 커밋 | 표면 |
|------|------|
| `a9903875d` | Grok (기준 구현) + `page-loading-contract.test.tsx` 신설 |
| `1b6dae373` | Subagents, Combos, Usage, Startup, Logs, Debug, Claude Code/Desktop |
| `8759e34de` | Storage, API, Models + 0ms 타이머 6곳 제거 |

계약 테스트가 12표면을 고정한다. 남은 3개는 Dashboard, Providers, Codex 인증인데,
세 곳 모두 이미 공용 리소스 계층이나 전용 컨트롤러를 쓰고 스켈레톤도 갖고 있어
어댑터로 감싸는 이득이 작다. Providers와 Codex 인증은 이번 커밋에서 0ms 타이머만
제거했다. 남은 판단은 WP3의 마지막 사이클에서 한다.

### 이번 사이클에서 드러난 것

- **0ms 타이머가 lint 규칙의 회피책이었다.** `react-hooks/set-state-in-effect`가 이펙트
  본문의 동기 setState를 막으므로 원저자가 타이머로 미뤘고, 그 타이머가 cleanup에서
  취소되면서 요청이 사라졌다. 마이크로태스크가 양쪽을 만족한다.
- **키가 바뀌는 재구독이 요청을 두 번 보냈다.** 새 키 구독의 콜드 페치와 deps 변경의
  강제 재검증이 겹쳤다. `useKeyedClientResource`에서 키가 함께 바뀐 경우를 건너뛰게 했다.
  WP4의 요청 감축에 그대로 기여한다.
- **모듈 캐시가 테스트 격리를 깬다.** 리소스 캐시가 모듈 레벨이라 앞선 케이스의 응답이
  다음 케이스의 콜드 마운트를 만족시켰다. 6개 테스트 파일에
  `clearClientResourceStoresForTests()`를 넣었다.

### 감사에서 걸린 것 (4건, 전부 수정됨)

소스 문자열을 검사하는 계약 테스트는 표면이 어댑터를 쓰는지까지만 본다. 마운트해서
돌려보면 런타임 결함이 따로 나왔다.

| 심각도 | 결함 | 원인 | 수정 |
|--------|------|------|------|
| High | Grok의 저장이 방금 켠 스위치를 되돌렸다 | draft를 비우면 이전 스냅샷으로 폴백 | 확정된 선택을 `setClientResourceData`로 먼저 발행한 뒤 draft 해제 |
| High | 로그가 지속 장애를 영구히 숨겼다 | 한 번 성공하면 이후 실패를 침묵 처리 | 연속 3회 실패 시 상시 notice + 재시도, 성공하면 해제 |
| Medium | API 키 화면에 live region이 두 개 | 키·모델이 동시에 재검증 | 키가 말하는 동안 모델 상태가 양보 |
| Medium | StrictMode에서 요청이 두 번 | 마이크로태스크는 취소되지 않는다 | 4곳에 identity 가드 |

회귀 테스트 4개를 붙였다: 저장만 했을 때 스위치가 유지되는지, 3회 실패 후 stale 고지가
뜨고 성공하면 사라지는지, stale 프로브가 빠른 재조회를 요청하는지(단위 + 계약).

### 원래 증상의 진짜 원인

"할당량 새로고침을 눌러야 로딩된다"의 기전을 B 단계에서 찾았다. `/api/startup-health`는
30초 캐시에서 즉시 답하고 실제 프로브는 백그라운드에서 푼다. 그래서 콜드 응답은 보수적인
임시값인데, 대시보드는 status만 꺼내 쓰고 "아직 확정 전"이라는 사실을 버렸다. 다음 30초
틱까지 임시값이 그대로 남았고, 그 사이 칩을 리마운트시키는 아무 동작(새로고침 클릭, 탭
이동)이 진짜 값을 불러오는 것처럼 보였다.

프로브가 `stale`을 함께 실어 보내고, 대시보드는 서버가 아직 작업 중이라고 말하는 동안
약 2초 뒤 다시 묻는다. stale 응답은 확정값처럼 캐시하지 않는다. 하드 에러는 일반 폴에
맡긴다 — 2초 안에 스스로 낫지 않으니 빠른 재조회는 죽은 엔드포인트를 두드리는 셈이다.

### 카탈로그 enum 사고 (#759)

WP3 중에 로컬 symlink 본이 `~/.codex/opencodex-catalog.json`을 쓰면서 zenmux 모델에
`input_modalities: [..., "video"]`를 넣었다. Codex는 이 필드를 `text|image|audio` 닫힌
enum으로 파싱하므로 **카탈로그 전체**를 거부했고, Codex 앱은 플러그인·앱·MCP가 0개인
"Unable to load apps" 상태가 됐다. 모델 하나의 메타데이터가 전부를 내린 것이다.

프로바이더 필터에서 `"video"`를 빼고, 모든 엔트리가 지나는 단일 지점
(`ensureStrictCatalogFields`)에서 enum으로 정규화한다. 남는 게 없으면 `["text"]`로
떨어뜨린다 — modality가 아예 없는 엔트리는 text-only보다 나쁘다. 사용자 카탈로그는
제자리 복구했다(백업 `~/.codex/opencodex-catalog.json.bak-video-repair`).

내부적으로 `"video"`는 정당하다: xAI 비디오 브리지(`images.videoBridgeEnabled`)와
vision-sidecar modality 배관이 비디오를 다룬다. 결함은 그 값이 Codex가 읽는 카탈로그
파일로 새어 나가는 것뿐이라, `catalog-vision-sidecar-modalities.test.ts`의 내부 비디오
추론은 그대로 둔다(12 pass).

### 게이트 (커밋된 트리 기준)

`bun run typecheck` clean, `gui lint` 0 error, `privacy:scan` passed,
`gui build` clean, GUI 스위트 418 pass.

GUI 스위트의 1 fail은 이 작업이 아니다. 다른 세션이 워크트리에서
`dash.syncCodexSubagentDefaultsHint` 문구를 고쳤고 단정문이 옛 문구를 기대한다.
`HEAD:gui/src/i18n/en.ts`에는 단정된 문구가 그대로 있다.

루트 `bun run test`는 완주 시간을 못 재고 남겼다. 다른 세션들의 루트 스위트가 동시에
네 개 돌고 있었고, `scripts/test.ts`가 바로 이 경합을 문서화한다(약 210초 런이 26분).
이번 사이클의 `src/` 변경은 `catalog-input-modality-enum.test.ts`(5 pass)와
`catalog-vision-sidecar-modalities.test.ts`(12 pass)를 직접 돌려 덮었다.

### 병행 세션과의 파일 공유

`gui/src/pages/use-dashboard-data.ts`가 두 세션의 변경을 동시에 담게 됐다. 스테이징을
파일 단위로 쪼개(내 hunk만 blob으로 만들어 `update-index`) 커밋 후보 트리가 단독으로
`tsc -b`를 통과하는지 확인했다. 그 사이 다른 세션이 PR 5건을 머지하면서 내 워크트리
변경까지 `91fc79c93`에 함께 커밋했다. 결과물은 HEAD에 온전히 들어갔고 게이트도
초록이라, 커밋 경계만 의도와 다르다.
