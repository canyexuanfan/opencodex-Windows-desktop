# 030 — Close-or-Defer: Rationale + Comment Drafts (wp4)

Three PRs close with an explanatory comment. Tone: appreciative, specific,
and pointing at the path forward. English.

## PR 644 — fix(windows): follow active Codex home for tray listener
- Rationale: the stated reproduction was found invalid; no regression
  coverage; the branch carries an unrelated scheduler hunk that regresses
  current dev. CHANGES_REQUESTED standing since review.
- Comment draft:
  > Closing this after maintainer re-review. The reproduction described in
  > the thread does not hold on current `dev`, the PR carries no regression
  > coverage for the tray-listener path, and it includes an unrelated
  > scheduler change that regresses behavior that has since landed on
  > `dev`. If the underlying issue still reproduces for you, a fresh,
  > minimal PR with a regression test is welcome. Thanks for the
  > investigation work here.

## PR 616 — fix: preserve hosted image tool preferences
- Rationale: implementation accepted in principle, but maintainers moved the
  work into integration PR #837; this PR stays only until #837 lands.
  Keeping it open longer just accumulates conflicts.
- Comment draft:
  > Closing as superseded. The behavior this PR protects was accepted, and
  > the implementation has been carried into #837, which integrates it with
  > the current tool-preference handling on `dev`. When #837 lands, this
  > change ships with it. Thank you — the contributor credit is preserved in
  > the integration branch history.

## PR 707 — security: harden post-merge service and management boundaries
- Rationale: first hardening tranche already landed via #697. The remaining
  8k-line draft conflicts with dev, spans multiple threat models in one
  unit, and still has unresolved credentialed-probe P1 findings. Policy
  needs focused, single-threat-model PRs.
- Comment draft:
  > Closing in favor of focused follow-ups. The first tranche of this
  > hardening landed with #697. The remaining scope here — service-token,
  > ownership-lock, probe-destination, updater, and browser controls — is
  > individually valuable, but an 8k-line multi-threat-model branch can no
  > longer be reviewed as one unit and now conflicts with `dev`. Please open
  > one focused PR per boundary, each with its own threat model and tests;
  > they will get fast security review. Thank you for pushing this forward.
