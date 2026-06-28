# 90 — Final review

Purpose: close the multi-pass security goal with an independent review and one
fresh verification bundle.

Required evidence:

- Phase docs updated with actual changed paths and test commands.
- Atomic commits for each code phase.
- `bun x tsc --noEmit`
- Relevant focused tests from phases 10 through 60.
- Independent read-only security/code review.

Completion rule:

Do not mark the goal complete unless every phase is either implemented and
verified or explicitly documented as unnecessary with code evidence.
