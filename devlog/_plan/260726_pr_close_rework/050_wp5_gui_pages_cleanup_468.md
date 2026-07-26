# WP5 — PR #468 Startup/Debug/Storage/Usage 정리

대상: PR #468 (Wibias), head `8b7c73fd`. `git merge-tree` clean (tree `744ca7e4`).
**선행: WP4(#466).** `client-resource.ts`와 `intl-formatters.ts`를 import하고,
WP4의 캐시 정리·비중첩 폴링 수정에 의존한다.

## 범위

```bash
git fetch origin pull/468/head:pr-468
git diff 9c7e922ebea660f9ea7c94e438416fa407983f5e..pr-468 -- \
  gui/src/pages/Debug.tsx \
  gui/src/pages/Startup.tsx \
  gui/src/pages/Storage.tsx \
  gui/src/pages/Usage.tsx \
  gui/src/pages/debug-claude-inbound-panel.tsx \
  gui/src/pages/debug-log-viewer.tsx \
  gui/src/pages/debug-settings-panel.tsx \
  gui/src/pages/debug-shared.ts \
  gui/src/pages/startup-sections.tsx \
  gui/src/pages/startup-shared.ts | git apply -3
```

`9c7e922e`(=#466 head) 기준 delta만 취해 상속된 `gui/src/api.ts`가 재생되지 않게 한다.

## 결함 1-3 — abort된 요청이 후속 요청의 loading을 해제

`apiBase`/range/surface가 바뀌면 교체 요청이 시작된 뒤에 이전 요청의 `finally`가 돌아
`loading=false`를 세운다. UI가 미완료 데이터를 확정된 것처럼 보여주고 컨트롤을 조기 활성화한다.

`gui/src/pages/Startup.tsx:113-116` — before:

```ts
} finally {
  setTrayLoading(false);
  setLoading(false);
}
```

after:

```ts
} finally {
  if (!signal?.aborted) {
    setTrayLoading(false);
    setLoading(false);
  }
}
```

`gui/src/pages/Storage.tsx:130-134` — before:

```ts
} finally {
  // Unconditional: aborted requests may briefly clear loading before the next
  // effect-owned fetch sets it true again (react-doctor: no-loading-flag-reset-outside-finally).
  setLoading(false);
}
```

after:

```ts
} finally {
  if (!signal?.aborted) setLoading(false);
}
```

`gui/src/pages/Usage.tsx:567-570` — before:

```ts
} finally {
  // Unconditional clear; a newer effect-owned fetch re-sets loading true.
  setLoading(false);
}
```

after:

```ts
} finally {
  if (!signal.aborted) setLoading(false);
}
```

린터를 만족시키려고 abort 가드를 약화한 것이므로, 소유권 판정으로 되돌린다.

## 결함 4 — `debugBusy` 제거로 PUT 중 컨트롤이 열려 있음

`gui/src/pages/Debug.tsx:15-20,125-145,161-168`.

import 교체:

```ts
import {
  setClientResourceData,
  useKeyedClientResource,
} from "../client-resource";
```

`const { t } = useI18n();` 뒤에 상태 추가:

```ts
const [debugBusy, setDebugBusy] = useState(false);
```

`setDebugFlag` 교체:

```ts
const setDebugFlag = async (
  flag: "debug" | "usage" | "injection" | "claude",
  enabled: boolean,
) => {
  setDebugBusy(true);
  try {
    const res = await fetch(`${apiBase}/api/debug`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [flag]: enabled }),
    });
    if (res.ok) {
      const next = await res.json() as DebugSettings;
      setClientResourceData(`debug-settings:${apiBase}`, next);
    }
  } catch {
    // Keep the last confirmed settings.
  } finally {
    setDebugBusy(false);
  }
};
```

`resetDebug`도 같은 형태로 교체하되 body는 `{ reset: true }`.

마지막으로 `debugBusy={false}` → `debugBusy={debugBusy}`.

PUT 응답을 그대로 캐시에 심는 것이 핵심이다. busy만 복원하고 `debugPoll.refresh()`를 부르면
컨트롤이 PUT 이전 값을 보여주는 상태로 다시 열린다.

## 결함 5 — Claude inbound 행 key 충돌

`gui/src/pages/debug-claude-inbound-panel.tsx:30-32`. 생산자가
`src/claude/inbound-debug.ts:85`에서 `Date.now()`를 찍어 같은 ms에 동일 모델 요청이
여러 건 잡히면 key가 겹친다.

before:

```tsx
{entries.map(entry => (
  <tr key={`${entry.at}:${entry.endpoint}:${entry.model}`}>
```

after (리팩터 이전 계약 복원):

```tsx
{entries.map((entry, index) => (
  <tr key={`${entry.at}-${index}`}>
```

링은 최신순이고 서버 시퀀스 필드가 없으므로 index 성분이 유일성을 만든다.

## 회귀 테스트

A-gate blocker 3 반영: 최초 안은 `installPendingFetch` / `render` / `refreshButton`을
정의 없이 참조했다. 세 헬퍼 모두 `dev`·#466·#467·#468 어디에도 없다. 컴파일 자체가
불가능했으므로 전체 파일 계약을 아래에 확정한다.

NEW: `gui/tests/react-doctor-pages.test.tsx`

### 파일 상단 — import와 전역 하네스 (필수, 생략 금지)

```tsx
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import Startup from "../src/pages/Startup";
import Storage from "../src/pages/Storage";
import Usage from "../src/pages/Usage";
import { DebugClaudeInboundPanel } from "../src/pages/debug-claude-inbound-panel";

const globals = [
  "document",
  "window",
  "navigator",
  "fetch",
  "ResizeObserver",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let container: HTMLElement;
let root: Root | null;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previous;

  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    ResizeObserver: { configurable: true, value: ResizeObserverStub },
  });
  Object.defineProperty(win, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

  container = document.createElement("div");
  document.body.append(container);
  root = null;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  win.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previous[key],
    });
  }
});
```

### 헬퍼 3종 — 정의 (blocker 3의 직접 해소)

```tsx
async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    if (!root) root = createRoot(container);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

type PendingRequest = {
  url: string;
  signal?: AbortSignal;
  reject: (reason?: unknown) => void;
};

/** Replaces global fetch with a queue that never settles on its own. */
function installPendingFetch(): PendingRequest[] {
  const pending: PendingRequest[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        pending.push({
          url: String(input),
          signal: init?.signal ?? undefined,
          reject,
        });
      }),
  });
  return pending;
}

function refreshButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find(candidate => candidate.textContent?.includes(label));
  if (!button) throw new Error(`refresh button not found: ${label}`);
  return button;
}
```

### 테스트 1-3 — abort 소유권 (Startup / Storage / Usage 동형)

```tsx
test("Startup keeps loading owned by the replacement request after the old request aborts", async () => {
  const pending = installPendingFetch();

  await render(<Startup apiBase="/old" />);
  expect(pending).toHaveLength(1);

  await render(<Startup apiBase="/new" />);
  expect(pending).toHaveLength(2);
  expect(pending[0]!.signal?.aborted).toBe(true);

  await act(async () => {
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
  });

  expect(refreshButton("Refresh").disabled).toBe(true);
  expect(container.textContent).toContain("Checking startup protection");
});
```

핵심은 **교체 요청이 시작된 뒤에** 이전 요청을 reject하는 순서다.

A-gate R2 blocker 3 반영: "동일 구조"로 넘기지 않고 Storage/Usage 본문도 전부 적는다.

```tsx
test("Storage keeps loading owned by the replacement request after the old request aborts", async () => {
  const pending = installPendingFetch();

  await render(<Storage apiBase="/old" />);
  expect(pending).toHaveLength(1);

  await render(<Storage apiBase="/new" />);
  expect(pending).toHaveLength(2);
  expect(pending[0]!.signal?.aborted).toBe(true);

  await act(async () => {
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
  });

  // Storage's button is "Rescan", not "Refresh" — see the label table below.
  expect(refreshButton("Rescan").disabled).toBe(true);
  expect(container.textContent).toContain("Scanning storage");
});

test("Usage keeps the replacement request loading after the previous request aborts", async () => {
  const pending = installPendingFetch();

  await render(<Usage apiBase="/old" />);
  expect(pending).toHaveLength(1);

  await render(<Usage apiBase="/new" />);
  expect(pending.length).toBeGreaterThanOrEqual(2);
  expect(pending[0]!.signal?.aborted).toBe(true);

  await act(async () => {
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Loading usage data");
});
```

Usage만 `toBeGreaterThanOrEqual(2)`인 이유: Usage 페이지는 range/surface에 따라 마운트당
요청을 2건 이상 낼 수 있어 정확 개수를 고정하면 취약해진다. abort 소유권 검증에는
`pending[0]`의 상태만 있으면 충분하다.

### 버튼 라벨 확정 (A-gate R3 blocker 1)

"B 단계에서 확인"으로 미뤘던 라벨을 실제 사전에서 읽어 확정했다.
`git show pr-468:gui/src/i18n/en.ts` 기준:

| 키 | en-US 렌더 | 사용처 |
|---|---|---|
| `startup.refresh` (`:40`) | `Refresh` | Startup 테스트 |
| `storage.refresh` (`:602`) | **`Rescan`** | Storage 테스트 |
| `debug.reset` (`:542`) | `Clear runtime overrides` | Debug 테스트 |

**Storage는 `Refresh`가 아니라 `Rescan`이다.** 위 Storage 테스트의
위 Storage 테스트 본문에 이미 반영했다. 잘못된 라벨을 쓰면 `refreshButton`이 헬퍼 안에서
throw해 수정 전후 모두 실패한다 — RED가 결함이 아니라 셀렉터 오류에서 나오므로
회귀 테스트로서 무의미해진다.

로딩 문구 3종(`"Checking startup protection"`, `"Scanning storage"`,
`"Loading usage data"`)도 B 단계 첫 동작에서 같은 사전으로 대조한다.

### 테스트 4 — PUT 중 컨트롤 잠금

```tsx
test("Debug disables settings during a PUT and installs the returned settings before re-enabling them", async () => {
  const initial = {
    enabled: false, usage: false, injection: false, claude: false,
    runtimeOverride: {},
    env: { debug: false, usage: false, injection: false, claude: false },
  };
  const updated = { ...initial, enabled: true, runtimeOverride: { debug: true } };

  let resolvePut!: (response: Response) => void;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return await new Promise<Response>(resolve => { resolvePut = resolve; });
      }
      return new Response(JSON.stringify(initial), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await render(<Debug apiBase="/debug-busy-regression" />);

  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Provider debug"]');
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute("aria-pressed")).toBe("false");

  await act(async () => toggle!.click());

  const switches = Array.from(container.querySelectorAll<HTMLButtonElement>("button.switch"));
  expect(switches).toHaveLength(4);
  expect(switches.every(button => button.disabled)).toBe(true);
  expect(refreshButton("Clear runtime overrides").disabled).toBe(true);

  await act(async () => {
    resolvePut(new Response(JSON.stringify(updated), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await Promise.resolve();
  });

  const updatedToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Provider debug"]');
  expect(updatedToggle?.disabled).toBe(false);
  expect(updatedToggle?.getAttribute("aria-pressed")).toBe("true");
});
```

### 테스트 5 — 행 key 유일성

```tsx
test("DebugClaudeInboundPanel does not emit duplicate-key warnings for simultaneous equal captures", async () => {
  const entry = {
    at: 1_700_000_000_000,
    endpoint: "messages",
    model: "claude-test",
    hasMetadataUserId: false,
    hasSystem: false,
  };

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  try {
    await render(<DebugClaudeInboundPanel entries={[entry, { ...entry }]} />);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(errors.join("\n")).not.toContain("Encountered two children with the same key");
  } finally {
    console.error = originalError;
  }
});
```

### 선행 확인 (B 단계 첫 동작)

`gui/tests/`가 테스트 루트로 동작하는지, `happy-dom`이 `gui/package.json`에 있는지,
`DebugClaudeInboundPanel`이 named export인지 세 가지를 먼저 확인한다.
하나라도 없으면 그 자체가 B 단계 첫 작업 항목이다.

RED→GREEN 근거: 1-3은 무조건 `finally`가 활성 요청의 loading을 지워 실패,
4는 `debugBusy={false}`라 disabled assertion에서 실패, 5는 중복 key 경고가 잡혀 실패한다.

## 활성화 시나리오

새 분기 3종이 모두 테스트로 활성화된다: `signal.aborted` 가드(1-3),
`debugBusy` 상태 전이(4), index 기반 key(5). 관찰 효과는 각각
로딩 텍스트 유지 / 버튼 disabled / 경고 부재다.

## 커밋

```
fix(gui): preserve request ownership and mutation state in page cleanup (#468)

Co-authored-by: Wibias <37517432+Wibias@users.noreply.github.com>
```

## 검증

```bash
cd gui && bun test tests/react-doctor-pages.test.tsx && cd ..
bun run typecheck
bun run lint:gui
```

`gui/src/pages/Usage.tsx`는 dev에서도 최근 레이아웃/접근성 작업이 있었다.
merge 결과에서 양쪽 변경이 모두 살아남았는지 확인한다.
