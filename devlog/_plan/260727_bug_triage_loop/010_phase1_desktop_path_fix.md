# 010 — WP1: Desktop 3P configLibrary 경로 해석 수정

대응 이슈: #539
근거: `003_claude_desktop_path_rca.md`

## 스코프

IN:

- `src/claude/desktop-3p-paths.ts` (NEW) — 경로 해석 단일 소스
- `src/claude/desktop-3p.ts` (MODIFY) — 헬퍼 사용 + `appliedId` 정합
- `src/server/management/agent-settings-routes.ts` (MODIFY) — 헬퍼 사용 + `appliedId` 반영
- `tests/claude-desktop-config-path.test.ts` (NEW) — 활성화 회귀 테스트

OUT: Desktop 프로필 생성 로직, 모델 렌더링, 인증/토큰 경로, GUI.

## 설계 원칙

Desktop 번들의 `GE()`를 그대로 옮긴다. 추측하지 않는다. 기존 macOS 기본값
(`Claude-3p`)은 세 번째 분기로서 보존된다 — 이것이 회귀 방지의 핵심이다.

## NEW: `src/claude/desktop-3p-paths.ts`

### 설계 결정: 순수 함수 + 얇은 래퍼 (A단계 감사 블로커 1 해소)

초안은 `node:os`의 `platform()`을 직접 호출했다. 이 저장소의 유일한 플랫폼 스텁 관용구는
`Object.defineProperty(process, "platform", ...)`인데(`tests/claude-management-api.test.ts:22`,
`tests/windows-elevation-spawn.test.ts:38`), Bun 1.3.14에서 이 스텁은 `os.platform()`에
전파되지 않는다. 직접 확인했다:

```
process.platform = win32 | os.platform() = darwin
```

따라서 초안대로 가면 win32 테스트가 통과하면서 실제로는 darwin 분기를 태운다. RCA가 가장
심각하다고 판정한 결함을 지키는 테스트가 공허해진다. 해석 로직을 `(env, platform)` 주입형
순수 함수로 분리하고, 얇은 래퍼가 런타임 값을 넘기는 구조로 확정한다.

```ts
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Desktop의 userData 디렉터리 (app.asar `GE()` 이식).
 *
 *   const Bu = "-3p", ND = `Claude${Bu}`;
 *   function GE(){
 *     if (process.env.CLAUDE_USER_DATA_DIR) return app.getPath("userData");
 *     if (win32 && LOCALAPPDATA) return join(LOCALAPPDATA, ND);
 *     const t = app.getPath("userData");
 *     return t.endsWith(Bu) ? t : `${t}${Bu}`;
 *   }
 */
const SUFFIX = "-3p";
const APP_DIR = `Claude${SUFFIX}`;

/** 순수 함수: 테스트가 env/platform/home을 직접 주입한다. */
export interface DesktopPathInputs {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

/** Electron `app.getPath("userData")` — appData + productName("Claude"). */
export function resolveElectronUserData(inputs: DesktopPathInputs): string {
  const { env, platform, home } = inputs;
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? join(appData, "Claude") : join(home, "AppData", "Roaming", "Claude");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "Claude") : join(home, ".config", "Claude");
}

export function resolveUserDataDir(inputs: DesktopPathInputs): string {
  const explicit = inputs.env.CLAUDE_USER_DATA_DIR?.trim();
  if (explicit) return explicit;

  if (inputs.platform === "win32") {
    const localAppData = inputs.env.LOCALAPPDATA?.trim();
    if (localAppData) return join(localAppData, APP_DIR);
  }

  const root = resolveElectronUserData(inputs);
  return root.endsWith(SUFFIX) ? root : `${root}${SUFFIX}`;
}

export function resolveConfigLibraryDir(inputs: DesktopPathInputs): string {
  const override = inputs.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR?.trim();
  if (override) return override;
  return join(resolveUserDataDir(inputs), "configLibrary");
}

/** 런타임 래퍼 — 얇게 유지한다. 분기 로직은 위 순수 함수에만 존재한다. */
export function claudeDesktopConfigLibraryDir(): string {
  return resolveConfigLibraryDir({ env: process.env, platform: process.platform, home: homedir() });
}
```

래퍼가 `process.platform`을 읽으므로 기존 `Object.defineProperty` 스텁도 유효하다. 다만
분기 테스트는 순수 함수를 직접 호출해 `platform`을 인자로 넘기는 쪽을 정본으로 삼는다.

`OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR` 오버라이드는 최우선을 유지한다. 기존 테스트
5개 파일 22곳이 이 변수로 임시 디렉터리를 주입하므로 순서를 바꾸면 전부 깨진다.

## MODIFY: `src/claude/desktop-3p.ts`

### 312행 — 경로 해석 교체

before:

```ts
  const libraryPath = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR?.trim()
    || join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
```

after:

```ts
  const libraryPath = claudeDesktopConfigLibraryDir();
```

import 추가:

```ts
import { claudeDesktopConfigLibraryDir } from "./desktop-3p-paths";
```

`homedir` / `join`이 이 파일의 다른 곳에서 쓰이지 않게 되면 import에서 제거한다
(사용처 확인 후 결정 — `tsc --noEmit`이 미사용 import를 잡지는 않으므로 수동 확인).

## MODIFY: `src/server/management/agent-settings-routes.ts`

### 547-548행 — 경로 해석 교체

before:

```ts
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const libraryPath = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR?.trim()
        || join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
```

after:

```ts
      const { join } = await import("node:path");
      const { claudeDesktopConfigLibraryDir } = await import("../../claude/desktop-3p-paths");
      const libraryPath = claudeDesktopConfigLibraryDir();
```

### 553-556행 — `appliedId` 반영

before:

```ts
          const meta = JSON.parse(readFile(metaPath, "utf8"));
          const entry = Array.isArray(meta.entries) ? meta.entries.find((e: { name?: string }) => e?.name === "opencodex") : undefined;
          if (entry?.id) {
            configPath = join(libraryPath, `${entry.id}.json`);
```

after:

```ts
          const meta = JSON.parse(readFile(metaPath, "utf8"));
          const entry = Array.isArray(meta.entries) ? meta.entries.find((e: { name?: string }) => e?.name === "opencodex") : undefined;
          // Desktop reads ONLY the profile named by appliedId. An opencodex entry that
          // exists but is not applied means Desktop is serving a different profile.
          const appliedId = typeof meta.appliedId === "string" ? meta.appliedId : null;
          activeProfile = appliedId !== null && entry?.id ? (appliedId === entry.id) : null;
          if (entry?.id) {
            configPath = join(libraryPath, `${entry.id}.json`);
```

응답에 필드 추가:

```ts
      return jsonResponse({
        applied: savedFingerprint !== null,
        appliedAt,
        savedFingerprint,
        onDiskFingerprint,
        configPath,
        stale,
        activeProfile,     // NEW: true=Desktop이 우리 프로필을 읽음, false=다른 프로필, null=판정 불가
        health,
      });
```

선언은 `onDiskFingerprint` 옆:

```ts
      let activeProfile: boolean | null = null;
```

`stale`과 분리하는 이유: `stale`은 "내용이 다르다"이고 `activeProfile`은 "아예 안
읽힌다"이다. 두 상태는 독립이며 후자가 더 치명적이다.

## NEW: `tests/claude-desktop-config-path.test.ts`

각 criterion을 실제로 트리거하는 활성화 테스트 (C-ACTIVATION-GROUNDING-01).

```ts
import { describe, expect, test, afterEach } from "bun:test";

// 분기 테스트는 순수 함수를 직접 호출한다 — process.platform 스텁이 os.platform()에
// 전파되지 않는 Bun 동작(확인: process.platform=win32 일 때 os.platform()=darwin)에
// 의존하지 않기 위해서다.

describe("Claude Desktop configLibrary 경로 해석", () => {
  test("CLAUDE_USER_DATA_DIR가 설정되면 -3p 접미사 없이 그 경로를 따른다", () => {
    // 활성화: resolveConfigLibraryDir({ env: { CLAUDE_USER_DATA_DIR: "/tmp/custom-ud" }, platform: "darwin", home })
    // 관측: "/tmp/custom-ud/configLibrary" 이고 "-3p" 미포함
  });

  test("기본 macOS 경로는 Claude-3p를 유지한다 (회귀 방지)", () => {
    // 활성화: env={}, platform="darwin"
    // 관측: ".../Application Support/Claude-3p/configLibrary"
  });

  test("OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR가 다른 모든 분기를 이긴다", () => {
    // 활성화: OPENCODEX_... 와 CLAUDE_USER_DATA_DIR 동시 설정
    // 관측: 오버라이드 값이 그대로 반환
  });

  test("win32 + LOCALAPPDATA는 LOCALAPPDATA/Claude-3p로 해석된다", () => {
    // 활성화: platform: "win32" 인자 + env.LOCALAPPDATA
    // 관측: join(LOCALAPPDATA, "Claude-3p", "configLibrary") 이고 darwin 결과와 다름
    //       (동일 입력을 platform만 바꿔 호출해 차이를 단언한다)
  });

  test("userData가 이미 -3p로 끝나면 중복 접미사를 붙이지 않는다", () => {
    // 활성화: home이 "-3p"로 끝나는 경로를 만들도록 구성
    // 관측: "Claude-3p-3p"가 생성되지 않음
  });

  test("래퍼가 순수 함수와 동일한 결과를 낸다 (배선 증명)", () => {
    // 활성화: claudeDesktopConfigLibraryDir() vs resolveConfigLibraryDir(런타임 입력)
    // 관측: 두 값이 일치 — 래퍼가 실제로 순수 함수를 호출함을 증명
  });
});
```

마지막 "배선 증명" 테스트가 없으면 순수 함수만 통과하고 래퍼가 실제로는 옛 하드코딩을
쓰는 상황을 잡지 못한다. 순수 함수 분리의 대가로 반드시 포함한다.

`appliedId` 테스트는 상태 라우트를 태우므로 기존 `tests/claude-management-api.test.ts`
패턴을 따른다:

```ts
test("appliedId가 다른 프로필을 가리키면 activeProfile이 false로 보고된다", async () => {
  // _meta.json에 opencodex 엔트리를 두되 appliedId는 Default의 id로 설정
  // GET /api/claude-desktop/status → activeProfile === false
});

test("appliedId가 opencodex 엔트리를 가리키면 activeProfile이 true다", async () => {
  // 관측: activeProfile === true
});
```

## 수용 기준

| 기준 | 활성화 시나리오 | 관측 가능한 효과 |
|------|-----------------|------------------|
| c-userdatadir | `CLAUDE_USER_DATA_DIR` 설정 | 경로에 `-3p` 없음 |
| c-windows | `platform=win32` + `LOCALAPPDATA` | `LOCALAPPDATA/Claude-3p/configLibrary` |
| c-appliedid | `appliedId` ≠ opencodex 엔트리 id | 상태 응답 `activeProfile === false` |
| c-baseline | 기본 darwin 환경 | `Claude-3p` 유지 + 4972 pass 이상 / 0 fail |

## 검증

```bash
bun run typecheck
bun test tests/claude-desktop-config-path.test.ts tests/claude-management-api.test.ts \
         tests/claude-desktop-cli.test.ts tests/desktop-3p-guard.test.ts
bun run test
```

## 커밋 / 푸시

커밋 메시지: `fix(desktop): resolve Claude Desktop configLibrary the way Desktop does`

푸시 대상은 `dev`. 사용자 승인 범위 내(#539 수정 한정)이며 `main`/`preview`/태그는 제외.
