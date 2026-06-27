---
title: 기여하기
description: opencodex 개발하기 — 설정, 구조, 컨벤션, 그리고 프로바이더나 어댑터를 추가하는 방법.
---

## 설정

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev          # proxy in dev mode
bun x tsc --noEmit   # typecheck (must be clean)
```

웹 대시보드는 별도의 앱입니다:

```bash
cd gui && bun install && bun dev
```

지금 읽고 있는 문서 사이트는 `docs-site/`에 있습니다(Astro + Starlight):

```bash
cd docs-site && bun install && bun dev
```

## 문서 배포

공개 문서는 GitHub Pages의 <https://lidge-jun.github.io/opencodex/ko/>에 게시됩니다.
`.github/workflows/deploy-docs.yml` 워크플로는 `main` 브랜치에서 `docs-site/**` 또는 워크플로
자체가 바뀔 때 실행되며, `docs-site`를 빌드한 뒤 배포합니다. 문서 변경을 푸시하기 전에 다음을
실행하세요:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI와 릴리즈

GitHub Actions는 의도적으로 짧게 유지합니다:

- **Cross-platform CI**(`.github/workflows/ci.yml`)는 런타임, 테스트, 패키지, 스크립트,
  TypeScript, 워크플로 파일이 바뀐 pull request와 `main` push에서 실행됩니다. Linux와 Windows에서
  install, typecheck, tests, release helper build smoke, `ocx help`를 검증합니다.
- **Release**(`.github/workflows/release.yml`)는 수동 실행만 허용합니다. Release는 두 번째 전체 CI
  파이프라인이 아니라, dry-run 또는 publish 전에 정확한 릴리즈 커밋(`GITHUB_SHA`)에 성공한
  Cross-platform CI run이 있는지 확인하는 배포 게이트입니다.

릴리즈에는 helper를 사용하세요:

```bash
bun run release <version>           # 버전 bump는 commit/push, publish workflow는 기본 dry-run
bun run release <version> --publish # CI-gated dry-run을 확인한 뒤 실제 publish
bun run release:watch               # 가장 최근 Release workflow run 감시
```

## 컨벤션

- **ES Modules 전용**(`import`/`export`), TypeScript, `strict` 모드. `bun x tsc --noEmit`을 깨끗하게
  유지하세요.
- **파일당 최대 약 500줄** — 책임별로 분할하세요(`web-search/`와 `vision/` 사이드카가 단일
  `index.ts` 뒤에 작고 집중된 모듈을 둔 좋은 예입니다).
- **비동기 에러는 경계에서 처리** — 사이드카는 요청 경로로 절대 throw하지 않으며, 우아한 마커로
  성능을 낮춥니다.
- **Structure SOT** — 현재 유지보수 불변식은 `structure/`에 둡니다. 공개 사용자 워크플로는
  `docs-site/`, 과거 조사/진단 노트는 `docs/`에 둡니다.
- **익스포트 보존** — 다른 모듈이 이에 의존할 수 있습니다.

## 카탈로그에 프로바이더 추가하기

대부분의 프로바이더는 API 키 카탈로그(`src/oauth/key-providers.ts`)의 항목 하나에 불과합니다:

```ts
"my-provider": {
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
}
```

`enrichProviderFromCatalog()`는 `models` / `noVisionModels` / `noReasoningModels`를 생성된
프로바이더 설정으로 복사하므로 분류가 자동으로 적용됩니다. OAuth 프로바이더의 경우 대신
`src/oauth/index.ts`의 `OAUTH_PROVIDERS`에 추가하세요.

## 어댑터 추가하기

`src/adapters/`에 `ProviderAdapter`([어댑터](/opencodex/ko/reference/adapters/) 참조)를 구현하고,
어댑터 리졸버에 등록한 뒤, 그 출력을 내부 `AdapterEvent`로 브리징하세요. 이미지 처리에는
`image.ts`를 재사용하고, 스트리밍 + 툴 호출의 레퍼런스로 `openai-chat.ts`를 따르세요.

## 완료를 주장하기 전에 검증하기

변경 사항을 증명하는 가장 좁은 명령을 실행하세요 — 타입에는 `bun x tsc --noEmit`, 동작에는 집중된
런타임 프로브. opencodex는 큰 배치보다 작고 검증 가능한 커밋을 선호합니다.
