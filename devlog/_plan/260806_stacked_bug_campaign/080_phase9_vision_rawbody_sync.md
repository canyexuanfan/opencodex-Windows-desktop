# 080 — Phase 9: vision raw-body image synchronization (PR #1047)

Credit: **Bailey** (`baileyh8 <baileyh8@gmail.com>`), PR #1047.
Adoption: **adapted** — one remaining leak closed.

## Defect

The Responses passthrough keeps a `_rawBody` copy that is not synchronized with
the caption-normalized input, so a vision sidecar's captions never reach the
forwarded payload — and unmatched `input_image` parts are forwarded verbatim to
a provider that cannot consume them.

## Why adapted

#1047's `syncRawBodyImageDescriptions` is the correct mechanism with strong E2E
coverage, but two gaps remain in the current tree:

- `src/vision/index.ts:294` skips normalization entirely when there are no
  captions — so a failed caption pass forwards the raw image instead of a safe
  substitute.
- `src/vision/index.ts:308-311` returns the original raw part for an unmatched
  image rather than removing or replacing it.

Both mean the "leak" the PR set out to close can still occur on the failure
path, which is exactly the path that matters.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/vision/index.ts` | MODIFY | Keep `syncRawBodyImageDescriptions`; run normalization even when the caption set is empty (`:294`); at `:308-311` remove or replace empty/unmatched `input_image` parts instead of returning the original |
| `tests/vision-*.test.ts` | MODIFY | Bailey's E2E cases plus: empty-caption path, unmatched-image path, and an assertion that no raw image survives into `_rawBody` |

## Verification

- `bun test tests/vision-*.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 08, base = stack 07 head. Credits Bailey; names the two failure-path gaps
added on top of their patch.
