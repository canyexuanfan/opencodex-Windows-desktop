# Unanswered issue resolution: #239, #240, #242, #246, #253, #257

## Outcome

- #239: a Codex OAuth 409 now cancels the abandoned server flow and retries once.
- #240: Codex, OAuth, and API-key pools support display-only aliases through GUI, API, and CLI.
- #242: GitHub Copilot device codes are structured, prominent, copyable, and no longer hidden by an automatic foreground browser launch.
- #246: adaptive Anthropic thinking receives effort-sized total-token headroom and `max_tokens` is preserved as an incomplete response.
- #253: subscription-mode Claude launches no longer claim host-managed authentication without a host token.
- #257: freshly initialized configs carry the current OpenAI tier version, so an older immutable migration backup cannot block startup. Bare OpenAI model ids still intentionally fail closed when no canonical OpenAI provider is enabled.

[Decision Log]
- 목적과 의도: Reproduce and resolve every unanswered report against current `dev`, while preserving existing routing and credential-security invariants.
- 기존 구현 및 제약 조건: OAuth and API-key pools use different stores; Codex accounts use config plus a separate credential ledger. Browser APIs cannot promise a background tab. The OpenAI migration backup is intentionally immutable.
- 검토한 주요 대안: Overwrite old migration backups; auto-open device verification and rely on users switching windows; use aliases as lookup keys; expose a manual-only OAuth recovery button.
- 선택한 방식: Mark new configs as current instead of weakening backup immutability; suppress automatic device-flow navigation and expose the code structurally; persist aliases only as optional display metadata; automatically cancel and retry one stale Codex login.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the reported dead ends without changing credential identity, account ids, active selection, routing, or backup evidence.
- 장점, 단점 및 영향: Existing data remains backward compatible and aliases may duplicate safely. Copilot login now needs an intentional link click, but the code stays visible and no browser focus theft occurs. The native/main Codex App slot remains non-renamable because it has no OpenCodex-owned persisted account row.

## Verification

- Focused adapter, bridge, Claude env, OpenAI migration, OAuth store, Codex API, provider key API, CLI account, Copilot OAuth, and workspace auth tests.
- Repository TypeScript typecheck, GUI i18n lint, privacy scan, and full test suite before push.
