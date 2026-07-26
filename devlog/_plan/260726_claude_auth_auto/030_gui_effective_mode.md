# 030 — WP3: Claude tab effective-mode badge + reason

Depends on WP2 (the GET payload fields). Small surface, mounted-tested.

## MODIFY — `gui/src/pages/ClaudeCode.tsx` state type

`ClaudeCodeState` gains:

```ts
effectiveAuthMode?: "proxy" | "subscription";
authModeOrigin?: "manual" | "auto-present" | "auto-absent" | "auto-unknown";
authFoundBy?: string;
authDetectionUnknown?: boolean;
```

mapped from the GET payload alongside the existing `authMode` mapping (`:44`).

## MODIFY — `gui/src/pages/claude-code-sections.tsx` (auth-mode row)

Under the existing select, one muted line that answers "what will actually happen on
the next `ocx claude` run":

- origin manual → `t("claude.effectiveMode.manual", { mode })`
- auto-present → `t("claude.effectiveMode.autoPresent", { source })` with the source
  mapped through `t("claude.authSource." + foundBy)` when known
- auto-absent → `t("claude.effectiveMode.autoAbsent")`
- auto-unknown → `t("claude.effectiveMode.autoUnknown")` rendered with the warning
  tone (amber), because the user should know detection failed.

The select itself is unchanged — manual persistence is already proven; this phase only
makes the resolution VISIBLE.

## Locale keys — NEW (all six)

| Key | en | ko |
|-----|----|----|
| `claude.effectiveMode.label` | `Effective on next launch` | `다음 실행 시 적용` |
| `claude.effectiveMode.manual` | `Manual: {mode}` | `수동: {mode}` |
| `claude.effectiveMode.autoPresent` | `Auto: subscription (Claude auth found via {source})` | `자동: 구독 ({source}에서 인증 발견)` |
| `claude.effectiveMode.autoAbsent` | `Auto: proxy mode (no Claude auth found)` | `자동: 프록시 모드 (인증 없음)` |
| `claude.effectiveMode.autoUnknown` | `Auto: subscription (auth could not be verified)` | `자동: 구독 (인증 확인 불가)` |
| `claude.authSource.claude-json-oauth` | `Claude account` | `Claude 계정` |
| `claude.authSource.claude-credentials-file` | `Claude credentials file` | `Claude 자격 증명 파일` |
| `claude.authSource.macos-keychain` | `macOS Keychain` | `macOS 키체인` |
| `claude.authSource.ocx-anthropic-oauth` | `opencodex Anthropic login` | `opencodex Anthropic 로그인` |
| `claude.authSource.exported-env` | `environment variable` | `환경 변수` |

ja/zh/de/ru in the same commit.

## TESTS

`gui/tests/claude-auth-mode-badge.test.tsx` (NEW, mounted):

- manual proxy → the manual line renders with the mode name, no auto wording;
- auto-present with foundBy macos-keychain → the subscription line names the keychain;
- auto-absent → the proxy line renders;
- auto-unknown → the warning line renders and carries the warning styling hook;
- every new key resolves in all six locales.

## Verification (C)

| Command | Expected |
|---------|----------|
| `cd gui && bun test tests/claude-auth-mode-badge.test.tsx` | pass |
| `cd gui && bun run test` / `lint:i18n` | pass / clean |
