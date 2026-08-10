# 040 — WP4: Lab evidence sanitization

Compatibility Lab assertion summaries carry provider-controlled text, and that
text is persisted in the `assertion_report` artifact and the observation event.
This work-phase makes the enforced boundary match the contract stated in
`structure/09_compatibility-lab.md`.

## Why this document carries no analysis

`AGENTS.md` §"Security working notes" gives the test: *is there already a
public diff that reveals this weakness?* Until the fix ships in a release, the
answer is no, so the finding detail, the leak reproductions, the residual
reasoning, and the bypass analysis stay in scratch. Only the shipped outcome is
recorded here.

An earlier revision of this file contained that analysis. It was caught by the
security re-review before push and moved to scratch. Worth restating: the rule
binds this agent exactly as `AGENTS.md` says it binds maintainers, and drafting
the plan in the public tree was a violation rather than a judgment call.

## What shipped

Commit `cb7d6c9c9`, plus the follow-up hardening from re-review.

- `src/lab/artifacts/sanitize.ts` — the shared scrubber gains ordered rules for
  UNC paths, non-HTTP URIs, JWTs, emails, prefixed and contextual account
  identifiers, MAC addresses, IPv6 (including mapped and scoped forms), IPv4,
  and hostnames, plus URL-path segment scrubbing. Every rule replaces a value
  whole or not at all.
- `truncateUtf8` — byte-bounded truncation matching what the event validator
  measures, splitting neither a code point nor a redaction marker.
- `src/lab/observe/from-live.ts`, `from-conformance.ts` — both event
  constructors sanitize before truncating.
- `src/lab/artifacts/store.ts` — non-contract artifacts declare
  `sanitized_evidence_v2`. Contract classes bypass mutation, so their pinned
  digests are unchanged.
- `tests/lab-evidence-sanitization.test.ts` — 9 tests covering redaction,
  recorded residuals, adversarial timing, truncation boundaries, and activation
  on both constructors and both sinks.
- `structure/09_compatibility-lab.md` — documents the enforced boundary and the
  categories deliberately left alone.

## Process record

The plan passed **7 adversarial audit rounds**; 19 blockers folded, none
rebutted. Each was independently reproduced before being accepted. A later
independent security re-review found four further bypasses in the shipped
implementation, all reproduced and fixed, with regressions added.

That is the substance worth keeping: a plan that reads correctly can still be
wrong in ways only execution reveals, and every round here was earned by a
reproducible defect rather than a style preference.

## Verification

- `bun test tests/lab-evidence-sanitization.test.ts` — 9 pass / 0 fail
- `bun test tests/lab-*.test.ts` — 138 pass / 0 fail
- full suite — 10,533 pass / 7 skip / 0 fail
- `bun run typecheck` exit 0; `bun run privacy:scan` passed
- Activation proven by ablation rather than a green suite: reverting the event
  sink, and separately the sanitizer rules, each turned the new tests red.
