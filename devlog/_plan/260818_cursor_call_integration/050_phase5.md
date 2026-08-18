# 050 — WP6: release gates on dev + go/no-go note

Revised after audit `r1` finding F5: these gates are a RE-RUN on merged `dev`, not
first contact. First contact is `020`, before the PR.

## Scope boundary (explicit)

IN: re-running the gates on merged `dev` and writing an evidence-backed readiness
note.

OUT unless the user says otherwise: `npm publish`, any version bump, `main`
promotion, tag creation. `scripts/release.ts` is the release authority and the
repository's OIDC workflow is the only publish mechanism — never a direct
`npm publish`.

## Gates

```
ssh lidge 'cd ~/Developer/opencodex && git fetch origin dev && git checkout -f origin/dev && git log --oneline -1'
ssh lidge 'cd ~/Developer/opencodex && bun install --frozen-lockfile'
ssh lidge 'cd ~/Developer/opencodex && bun x tsc --noEmit'
ssh lidge 'cd ~/Developer/opencodex && bun run privacy:scan'
ssh lidge 'cd ~/Developer/opencodex && bun run audit:high'
ssh lidge 'cd ~/Developer/opencodex && bun test --isolate tests'
```

GUI gates (`lint:gui`, `build:gui`) are N/A for a source-only diff — record the
evidence (`git diff --name-only` showing no `gui/` paths) rather than skipping
silently.

## Docs-site determination (must already be made at `030`)

- Cursor tool-result images: the encoder supports them, but production strips them
  upstream (`005` F1). **Do not document a capability that does not reach the
  provider.** If `docs-site/` says the Cursor adapter cannot send images, that text
  is currently still accurate end-to-end and stays.
- Truncated-turn reporting (`failed` instead of `completed`) is a correctness fix
  in a failure path, not a documented feature. No docs change.

Record the determination and its reasoning; a bare "no docs needed" is not evidence.

## Go/no-go note

Write `060_release_readiness.md` with:

- every gate, its command, its output, and the SHA it ran against;
- the governance position from `040` verbatim: gates green on Linux, CI waived by
  the owner, merge was an owner-authorized exception;
- the open follow-ups from `000` that a reader would otherwise assume were fixed —
  especially F1, because the campaign's own docs previously overstated it;
- whether `dev` is releasable as-is;
- an explicit recommendation on cutting a version, with the reason. Released
  version is `2.24.2` (`origin/main` = `474584bcd`, tag `v2.24.2`). A
  provider-correctness batch of this size is a minor-bump candidate, but the
  decision is the maintainer's — state the recommendation, do not act on it.

## Verification (C)

All gate commands exit 0 at a named `dev` SHA, and the note exists and is committed.

