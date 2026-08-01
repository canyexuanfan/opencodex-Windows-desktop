# 020 — Build-Ourselves-Worthy: Deep Review Plan + Direction Comments (wp3)

These two PRs are valuable enough that maintainers should drive them to
landing even if the author stalls. Neither merges today: both need explicit
security/design review. wp3 dispatches one deep-review subagent per PR and
posts a maintainer direction comment with the outcome.

## PR 865 — feat(proxy): opt-in same-target 429 wait-and-retry before key failover (#487)

- Why it matters: core proxy resilience; recovers transient 429s without
  burning the key/account pool. Repeatedly requested (#487 lineage).
- Scale: +1,965/-70 across 37 files (routing, adapters, images/web-search
  loops, config, GUI, docs ×5 locales, devlog, structure).
- Historical bot findings (20, worst Critical) all marked resolved — the
  deep reviewer must re-verify the Critical-class ones against the current
  head, especially:
  - 429 backoff must not consume the cumulative header deadline (silent
    waits up to 600s vs 300s core / 330s web-search stall budgets).
  - Upstream heartbeats during 429 backoff so the bridge stall detector
    does not abort healthy waits.
  - Retry budget scoping: per-request across key rotation / account
    rotation / image-tier continues (no per-iteration reset).
  - Auth-mode gating: retries only for `authMode: "key"` providers; local /
    oauth / forward modes must fail closed.
  - Same-key replay must replay a cached body-safe representation of the
    identical request, not rebuild it.
- Direction comment: name the architecture-review items, require full CI on
  current head, state maintainer takeover intent if the author stalls.

## PR 863 — feat(codex): add encrypted native main profiles

- Why it matters: transactional switching/recovery among native Codex main
  accounts (issue #656) — a repeatedly requested account-pool capability.
- Scale: +2,479 lines including a 401-line vault module and a new native
  keyring dependency. Credential storage = highest security boundary per
  MAINTAINERS.md.
- Deep reviewer focus:
  - Key management: what encrypts the vault, where the key lives, what
    happens on keyring unavailability (must fail closed, never plaintext
    fallback).
  - New native dependency: supply-chain and install-script surface
    (privacy:scan + release gates).
  - Transactional semantics: partial-switch recovery, no torn state where
    the proxy points at account A while the native login is account B.
  - Logging/serialization: no credential material in logs or management
    payloads (AGENTS.md privacy boundary).
- Direction comment: security-review checklist the PR must satisfy before
  merge consideration; maintainer takeover intent.
