# 050 — WP6: release gates on dev + go/no-go note

## Scope boundary (explicit)

IN: running the release gates on merged `dev` and writing an evidence-backed
readiness note.

OUT, unless the user says otherwise: `npm publish`, any version bump,
`main` promotion, tag creation. `scripts/release.ts` is the release authority and
the repository's OIDC workflow is the only publish mechanism — never a direct
`npm publish`.

## Gates

```
ssh lidge 'cd ~/Developer/opencodex && git fetch origin dev && git checkout -f origin/dev && git log --oneline -1'
ssh lidge 'cd ~/Developer/opencodex && bun install --frozen-lockfile'
ssh lidge 'cd ~/Developer/opencodex && bun x tsc --noEmit'
ssh lidge 'cd ~/Developer/opencodex && bun run privacy:scan'
ssh lidge 'cd ~/Developer/opencodex && bun test --isolate tests'
```

GUI gates (`bun run lint:gui`, `bun run build:gui`) are only required if the merge
touched `gui/`. This campaign does not, so record that as N/A with the evidence
(`git diff --name-only` showing no `gui/` paths) rather than skipping silently.

## Docs-site check

Repository policy: user-facing behavior changes should update `docs-site/`. Decide
per change and record the reasoning:

- Cursor tool-result images now reach the provider as real image content — a
  capability change a user can observe. Check whether `docs-site/` claims the
  adapter cannot send images anywhere (`cc906b0fc` already removed one such claim
  from source comments).
- Truncated-turn reporting (`failed` instead of `completed`) is a correctness fix
  in the failure path, not a documented feature.

## Go/no-go note

Write `devlog/_plan/260818_cursor_call_integration/060_release_readiness.md` with:

- every gate, its command, its output, and the SHA it ran against;
- whether `dev` is releasable as-is;
- an explicit recommendation on cutting a version, with the reason. Current
  released version is `2.24.2` (`origin/main` = `474584bcd`, tag `v2.24.2`).
  A provider-correctness batch of this size is a minor bump candidate, but the
  decision is the maintainer's — state the recommendation, do not act on it.

## Verification (C)

All gate commands exit 0 at a named `dev` SHA, and the note exists and is committed.

