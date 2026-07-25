---
created: 2026-07-26
status: plan
phase: wp1
blockers: [B3, B5]
tags: [grok-build, toml, data-safety]
---

# 010 — 설정 안전성 코어 (B3 인용 키, B5 개행 복원)

대상 파일: `src/grok/inject.ts`, `tests/grok-config-inject.test.ts`.
근거: `000_blocker_inventory.md` B3/B5, `001_grok_source_evidence.md` E1.

## B3 — 첫 키 세그먼트 정규화

### 현재

```ts
const header = /^\s*\[\s*model\s*\.\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/gm;
```

첫 세그먼트 `model`이 리터럴이라 `["model"."x"]`, `['model'.x]`를 놓친다.

### 변경

두 세그먼트를 대칭적으로 다루는 형태로 재작성한다. 세그먼트 문법을 한 번만 정의하고 재사용:

```ts
// bare | basic-string | literal-string — TOML이 허용하는 키 세그먼트 세 형태.
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const MODEL_HEADER = new RegExp(
  String.raw`^\s*\[\s*(${KEY_SEGMENT})\s*\.\s*(${KEY_SEGMENT})\s*\]\s*(?:#.*)?$`,
  "gm",
);
```

그리고 세그먼트 → 실제 키 문자열로 되돌리는 단일 정규화 함수를 도입한다:

```ts
/** TOML 키 세그먼트(bare/basic/literal)를 그것이 가리키는 실제 키로 되돌린다. */
function canonicalKeySegment(raw: string): string | null {
  if (raw.startsWith('"')) return decodeTomlBasicString(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1); // literal string: 이스케이프 없음
  return raw;
}
```

`userModelAliases()`는 이제 첫 세그먼트가 정규화 후 `model`인 헤더만 채택한다:

```ts
for (const match of outsideManagedRegion.matchAll(MODEL_HEADER)) {
  if (canonicalKeySegment(match[1]!) !== "model") continue;
  const alias = canonicalKeySegment(match[2]!);
  if (alias !== null) aliases.add(alias);
}
```

기존 `decodeTomlBasicString`은 그대로 재사용한다(이미 `\uXXXX`/`\UXXXXXXXX` 처리 검증됨).
리터럴 문자열(`'...'`)은 TOML상 이스케이프가 없으므로 디코드하지 않는 현재 동작이 옳다.

### 방출 측 대칭 확인

`buildGrokManagedBlock()`은 `ocx-` 접두 + `[^A-Za-z0-9_-]` 치환으로 alias를 만들므로 점이 남지
않는다(E1의 점-alias 함정에 해당하지 않음). 이 성질이 회귀하지 않도록 테스트로 고정한다.

### 회귀 테스트 (`tests/grok-config-inject.test.ts` 추가)

1. `["model"."ocx-gpt-5"]`를 소유한 설정 → 생성 블록이 `[model.ocx-gpt-5]`를 재사용하지 않고
   `[model.ocx-gpt-5-2]`로 회피.
2. `['model'.ocx-gpt-5]` 동일.
3. `[ "model" . 'ocx-gpt-5' ]` 공백/혼합 인용 동일.
4. 방출된 모든 alias에 `.`이 없음 (점-alias 함정 고정).

## B5 — 주입 구분자의 정확한 복원

### 현재

inject: `const separator = content.endsWith("\n") ? "\n" : "\n\n";`
strip: `if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);` — 항상 하나만 제거.

원래 개행이 없던 파일은 `ocx stop` 후 개행 하나를 얻는다.

### 변경 방침

구분자를 마커 자체에 기록하지 않는다(마커 문자열은 이미 배포된 사용자 파일에 존재하므로 형식을
바꾸면 기존 블록과 호환이 깨진다). 대신 **복원 규칙을 대칭으로 만든다**:

- inject는 그대로 두되, 개행 없는 파일에 붙일 때 우리가 넣은 것이 정확히 `"\n\n"`임을 명시한다.
- strip은 제거 후의 접미 상태로 판단하지 말고, **블록 앞에 우리가 넣은 분리 개행을 모두** 되돌린다:

```ts
let prefix = content.slice(0, region.start);
const restOfFile = content.slice(removalEnd);
if (restOfFile.length === 0) {
  // 블록이 파일 끝에 있었다 = 주입 시 우리가 앞에 분리 개행을 붙인 경우.
  // 사용자 원문이 개행으로 끝나지 않았다면 "\n\n"을, 끝났다면 "\n"을 넣었으므로
  // 남은 접미 개행을 하나만 남기고(원문이 개행으로 끝났던 경우) 혹은 전부 제거한다.
  prefix = prefix.endsWith("\n\n") ? prefix.slice(0, -2) + "\n" : prefix.replace(/\n$/, "");
}
```

판정 근거: 블록은 항상 파일 끝에 추가되거나(신규) 기존 영역을 제자리 치환한다(갱신).
제자리 치환 경로에서는 구분자를 추가하지 않으므로 복원 대상이 없다. 따라서 되돌릴 구분자가
존재하는 경우는 "블록 뒤에 아무것도 없는" 경우로 한정된다.

**주의:** 사용자가 블록 뒤에 자기 내용을 덧붙였다면 `restOfFile`이 비지 않으므로 접두를 건드리지
않는다 — 사용자 바이트를 임의로 줄이지 않는 보수적 동작이다.

### 회귀 테스트

1. 개행 없이 끝나는 원문 → inject → strip → **원문과 바이트 동일**.
2. 개행 하나로 끝나는 원문 → 왕복 후 바이트 동일 (기존 테스트 강화).
3. 개행 두 개로 끝나는 원문 → 왕복 후 바이트 동일 (사용자 개행을 삼키지 않음).
4. 블록 뒤에 사용자 섹션이 있는 경우 → 왕복 후 바이트 동일.
5. CRLF 원문에서 1–4 반복(기존 `dominantEol`/`applyEol` 경로 유지 확인).

## 게이트

`bun test tests/grok-config-inject.test.ts` → `bun run typecheck`.
