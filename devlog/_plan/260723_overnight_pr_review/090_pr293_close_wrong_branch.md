# 090 — PR #293: [WRONG BRANCH] fix(responses): ChatGPT non-stream buffer

- **Author:** PyEL666
- **Branch:** fix/chatgpt-nonstrream-buffer-and-mimo-hardening → **main** (wrong!)
- **CI:** enforce-target FAIL (branch check)
- **Decision:** CLOSE with comment

## Why Close

- Targets `main` instead of `dev`. Title already flags this.
- enforce-target CI correctly rejects it.

## Salvageable Ideas

1. SSE buffering for stream:false clients: `bufferResponsesSseToJson()` — reconstructs response.completed output from streamed events.
2. Mimo-free retry hardening: 5xx retry loop, 441 abuse block rotation.
3. Reasoning effort clamping for mimo-free.
4. Force stream:true on ChatGPT wire requests.

## Rebuild-on-dev Assessment

- The SSE buffering logic (150 lines) is substantial and addresses a real gap.
- The mimo retry changes are aggressive (client-id rotation, file deletion) — needs careful review.
- Recommendation: evaluate rebuild in Phase 2 after main merges complete.
