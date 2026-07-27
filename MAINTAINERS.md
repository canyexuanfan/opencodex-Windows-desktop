# Maintainers

This document lists the people responsible for maintaining opencodex and defines the project's
review and merge policy.

## Current maintainers

| GitHub account | Project role | Responsibilities |
| --- | --- | --- |
| [@lidge-jun](https://github.com/lidge-jun) | Project owner | Project direction, releases, repository administration, and final governance decisions |
| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | Issue and pull-request triage, `dev` integration, security review, and repository maintenance |
| [@Wibias](https://github.com/Wibias) | Maintainer | Issue and pull-request triage, `dev` integration, and provider/CI maintenance |

The table describes project responsibilities. Actual repository permissions remain controlled
through GitHub repository settings.

## Review and merge policy

- Pull requests target `dev` by default. `dev2-go` is a parallel integration
  line reserved for Go native-port work; it converges back through
  maintainer-controlled merges, and promotion to `main` still happens only from
  `dev`. The target-branch check does not recognise that line yet — it prefixes
  the title with `[WRONG BRANCH]`, forces such pull requests to draft, and runs
  again on every edit or ready-for-review event, so that state holds and
  blocks merging entirely. Until the check is updated, `dev2-go` takes
  maintainer pushes but not pull requests.
- A pull request requires approval from at least one maintainer and successful required CI checks
  before merge.
- Authors do not approve their own pull requests.
- Authentication, credential handling, GitHub Actions, release automation, dependency installation,
  and other security-boundary changes require explicit security review.
- Security-sensitive and release-related changes should be reviewed by both maintainers when
  practical.
- Direct pushes are reserved for maintainer-owned integration work, urgent repairs, or incident
  recovery. The same CI and documentation requirements still apply.
- Promotion from `dev` to `main` and npm releases is maintainer-controlled.

## Maintainer changes

Adding or removing a maintainer requires:

1. agreement from the project owner,
2. review by another current maintainer when available, and
3. updates to this file and [`.github/CODEOWNERS`](./.github/CODEOWNERS).

### Change log

- 2026-07-27 — [@Wibias](https://github.com/Wibias) added as a maintainer at
  the project owner's request (requirement 1). Requirement 2, review by another
  current maintainer, is satisfied by the review on the pull request that lands
  this change; the entry is recorded here at merge time. Scope covers issue and
  pull-request triage, `dev` integration, and provider/CI maintenance.
  Security-boundary ownership in `.github/CODEOWNERS` is deliberately
  unchanged: authentication, credential handling, GitHub Actions, and release
  automation keep the two owners already listed for those paths, so this
  addition does not widen the review surface for them. Note that CODEOWNERS
  requests reviews rather than enforcing them — no branch protection rule is
  configured on this repository, so code-owner approval is a convention here,
  not a gate. Widening the boundary, or enforcing it, is a separate decision.

## Security reports

Private vulnerability reports are handled by the current maintainers according to
[`SECURITY.md`](./SECURITY.md). Do not disclose secrets or exploit details in a public issue.
