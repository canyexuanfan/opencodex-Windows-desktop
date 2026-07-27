# 040 — WP2(재계획): orphan span을 fence 경계에서 클램프

대응: GitHub #511 (재개)
근거: `004_grok_orphan_adjacency_defect.md`

## 스코프

IN:

- `src/grok/inject.ts` — `findOpencodexOrphans`의 span 계산
- `tests/grok-orphan-adoption.test.ts` — fence 인접 회귀 테스트 추가

OUT: 소유권 판정식 변경, 문서 수동 레시피 문제(#511 리뷰 블로커 2), 고아 END wedge
(블로커 3), dangling default(블로커 4). 각각 독립 결정이 필요하므로 WP5로 분리한다.

## 결함 요약

`findOpencodexOrphans`는 orphan의 본문 끝을 다음 **테이블 헤더**로 잡는다:

```ts
const bodyEnd = headers[position + 1]?.index ?? content.length;
```

`ANY_TABLE_HEADER`(86행)는 테이블 헤더만 수집하고 `BEGIN_MARKER`(20행)는 주석이다.
따라서 orphan과 fence 사이에 다른 테이블이 없으면 span이 마커를 넘어간다.

## 수정

### `src/grok/inject.ts` — `findOpencodexOrphans`

함수 시작부에 fence 상한을 한 번만 계산한다. `region`이 있으면 그 시작점이고,
없으면(마커가 아직 없는 파일) `BEGIN_MARKER`를 직접 찾는다:

```ts
function findOpencodexOrphans(content: string, region: ManagedRegion | null): OrphanTable[] {
  const orphans: OrphanTable[] = [];
  // A pre-fence orphan's body must stop AT the fence. The managed block opens with a
  // comment, not a table header, so a span that runs to "the next table header" swallows
  // the BEGIN marker whenever no other table separates them — and removing the orphan
  // then deletes the fence opener itself (#511 follow-up).
  const fenceStart = region ? region.start : content.indexOf(BEGIN_MARKER);
  const clampEnd = (start: number, end: number): number =>
    fenceStart >= 0 && start < fenceStart ? Math.min(end, fenceStart) : end;
```

본문 끝 계산에 적용:

```ts
-    const bodyEnd = headers[position + 1]?.index ?? content.length;
+    const bodyEnd = clampEnd(header.index, headers[position + 1]?.index ?? content.length);
```

하위 테이블 확장에도 동일 상한을 적용한다. 이걸 빠뜨리면 `[model.x.extra_headers]`를
따라가다 같은 방식으로 마커를 넘어간다:

```ts
-      end = headers[next + 1]?.index ?? content.length;
+      end = clampEnd(header.index, headers[next + 1]?.index ?? content.length);
```

자식 헤더 자체가 fence 안쪽이면 순회를 멈춰야 한다:

```ts
       const child = headers[next]!;
+      if (fenceStart >= 0 && child.index >= fenceStart) break;
       if (child.segments.length <= 2) break;
```

### 왜 `region.start`와 `indexOf`를 둘 다 쓰는가

`region`은 `orphaned` 상태일 수 있지만 그 경우 호출부(368행)가 이미 `orphanedMarkerResult`로
거부하므로 여기 도달하지 않는다. `region`이 `null`인 경우는 마커가 아예 없는 파일이고,
그때 `indexOf`는 `-1`을 반환해 클램프가 자동으로 비활성화된다. 즉 fence 없는 파일의
기존 동작은 그대로다.

## 회귀 테스트

`tests/grok-orphan-adoption.test.ts`에 추가. 기존 픽스처가 전부 orphan과 fence 사이에
다른 테이블을 두고 있어서 이 결함을 놓쳤으므로, **인접**이 핵심 조건이다.

```ts
test("an orphan adjacent to the fence does not swallow the BEGIN marker (#511)", () => {
  // orphan 바로 다음 줄이 BEGIN 마커인 배치. 사이에 어떤 테이블도 없다.
  // 3회 연속 inject 후 단언:
  //   - BEGIN 1개, END 1개 (마커 파괴 없음)
  //   - run2부터 changed === false (수렴)
  //   - 모델 테이블 1개 (중복 제거됨)
  //   - default가 진동하지 않고 살아남은 별칭을 가리킴
});
```

수정 전 이 테스트가 실패함을 먼저 확인한다 — 통과하는 테스트를 추가하면 결함을 증명하지
못한다.

## 수용 기준

| 기준 | 활성화 | 관측 |
|------|--------|------|
| c-grok-adjacency | fence 인접 orphan 3회 sync | `BEGIN=1 END=1`, run2부터 `changed=false`, 테이블 1개 |
| 무회귀 | 전체 스위트 | 4985 pass 기준선 대비 신규 실패 0건 |
| SEPARATED 보존 | 기존 레이아웃 | 기존 55건 계속 통과 |

## 검증

```bash
bun test tests/grok-orphan-adoption.test.ts tests/grok-config-inject.test.ts
bun run typecheck
bun run test
```

푸시는 하지 않는다. `dev`에 `e7d144fc` 충돌이 미해결 상태이므로 커밋까지만 하고
사용자 결정을 기다린다.
