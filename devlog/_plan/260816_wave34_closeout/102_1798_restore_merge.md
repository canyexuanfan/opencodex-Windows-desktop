# 102 — #1798: restore must survive an app rewrite

One PABCD cycle. Runs AFTER `101` — also touches `src/codex/inject.ts`.

## Verified state

1. Injection stores original bytes plus an injected hash.
2. The Codex App rewrites `config.toml`.
3. Restore sees the hash mismatch and refuses journal restoration (`src/codex/journal.ts:123`).
4. Fallback removal only recognizes an `openai_base_url` immediately preceded by the OpenCodex marker (`src/codex/injected-marker.ts:53`), because `removeCodexConfig` bases ownership on that predicate (`src/codex/inject.ts:1193`).
5. The app-rewritten, unmarked line therefore survives.

Partially satisfied already: catalog backup lookup falls back from the hash-named backup to the legacy backup for the default path (`src/codex/catalog/parsing.ts:545`).

## Required shape

Replace exact-byte restore-or-strip with a three-way semantic merge over baseline B (what we saved at injection), injected I (what we wrote), and current C (what is on disk now):

- A key whose current value equals I is ours — remove it, or restore B's value if B had one.
- A key whose current value differs from BOTH B and I was changed by the user or the app — preserve it.
- A key present in B, absent from I, and absent from C was removed by someone else — do not resurrect it.

**Do not ship a marker-only deletion patch.** An unmarked `openai_base_url` may be genuinely user-owned; deleting it because it looks like ours is data loss, and it is the failure mode this issue is one half of.

When the merge cannot classify a key confidently, leave it and report it. A restore that says "I left these three lines, check them" is far better than one that silently deletes a user's setting.

## Tests

- App rewrites the injected line unmarked: restore removes it and preserves an unrelated user key added in the same rewrite.
- User sets their own `openai_base_url` before injection: restore returns THAT value, not absence.
- User edits an unrelated key after injection: it survives restore byte-identical.
- Hash mismatch no longer means give-up: the merge path runs and the home ends clean.
- The catalog fallback at `parsing.ts:545` keeps working; add a regression if none pins it.
