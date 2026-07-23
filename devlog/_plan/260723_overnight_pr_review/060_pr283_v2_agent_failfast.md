# 060 — PR #283: fix(v2): fail fast on unreadable routed agent tasks

- **Author:** MathiasHeinke (Mathias)
- **Branch:** codex/v2-encrypted-task-failfast → dev
- **Status:** Draft → needs undraft before merge
- **CI:** All pass (8/8 checks)
- **Decision:** MERGE (undraft first)
- **Risk:** Medium (touches responses.ts, but well-isolated guard)

## Changes

1. `src/server/responses.ts`:
   - `readableAgentMessagePayload()` — extracts readable text from V2 agent message content, stripping routing envelope.
   - `hasUnreadableEncryptedAgentTask()` — detects Fernet-encrypted agent tasks with no readable payload.
   - Guard in `handleResponses()`: returns 400 before auth/adapter/network when a non-ChatGPT route receives an undecryptable V2 task.
2. `tests/v2-agent-message-failfast.test.ts` — 145 lines. Tests: Fernet-only detection, readable payload bypass, non-agent-message bypass, routed vs native provider behavior.

## Security Review

- This is a security IMPROVEMENT: prevents cost storms from retrying undecryptable tasks.
- Error message reveals no ciphertext or request content.
- Uses `isCanonicalOpenAiForwardProvider()` to distinguish native ChatGPT routes.
