# 003 — Dispositions (closes, comments, and review requests)

User authorization on record: close duplicates and absorbed items, request
review where needed, extend the stack with new fixes.

## Issue closes

| Item | Action | Evidence |
|------|--------|----------|
| #1078 | close as duplicate of #1075 | identical body, same author, #1075 is 38 minutes earlier; cross-link both ways |

## Issues confirmed as fixable defects → stack extension

| Item | Decade doc | Branch |
|------|-----------|--------|
| #1075 (+#1078) shadow-call bare id | 010 | `codex/1075-shadow-call-namespaced` |
| #1065 DeepSeek 502 first-byte stall | 020 | `codex/1065-bounded-body-first-byte` |

## PR review comments (no closes — none absorbed)

| PR | Action |
|----|--------|
| 1085 | leave open; note READY verdict, flag security review as the gate |
| 1084 | review comment: no-consumer pool config, anthropic-only cooldown no-op, quota duplication |
| 1083 | review comment: filter is cosmetic, dead i18n keys, missing regression test |
| 1081 | review comment: does not compile (6 locales + `locale` undeclared), token-vs-plan expiry semantics, partial dev absorption of `expiresAt` |
| 1079 | review comment: does not compile (6 locales), missing promised breakdown, `yesterday` semantics |
| 1077 | review comment: argv-token secrecy, missing GUI screenshot, sponsorship required |

## Feature issues left open (out of scope)

#1086, #1082, #1076, #1073 — enhancements, not bugs; no action this round.
