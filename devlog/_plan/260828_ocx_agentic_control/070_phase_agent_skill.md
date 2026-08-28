# 070 — wp8: the `ocx` agent skill and docs-site reference

Branch: `codex/ocx-agent-skill` off `codex/ocx-gui-parity`.

Every prior phase widened what an agent *can* do. This phase makes it *discoverable*
without reading the source.

## 070.1 — where the skill lives

NEW `skills/ocx/SKILL.md` in this repository, plus `skills/ocx/references/`.

Repo-owned, not `$CODEX_HOME/skills`: the skill describes this repository's CLI
contract and must version with it. A user-directory copy goes stale the moment the
CLI changes, which is the same drift class as the 20 dead `USAGE` constants.

```
skills/ocx/
  SKILL.md                        entry point, routing, safety rules
  references/
    01_management_surface.md      capability -> route map, generated
    02_json_shapes.md             response envelopes and error shapes
    03_recipes.md                 copy-paste task recipes
    04_failure_semantics.md       exit codes, 503 classes, what to retry
```

## 070.2 — the generated half

`references/01_management_surface.md` is **generated from wp3's capability table**,
not hand-written, by a script under `scripts/`. A test asserts the committed file
matches regeneration.

Hand-writing it would recreate the exact defect this unit removed: a second
description of the surface, free to drift from the first. If the generator and the
committed file disagree, CI fails and someone regenerates.

## 070.3 — SKILL.md content

Front matter with `name: ocx` and a description naming real triggers (`ocx`,
opencodex, proxy control, account pool, provider routing, usage report, access key,
management API), so it activates on the tasks it covers.

Body sections:

**Orientation.** `ocx capabilities --json` first. It is the machine-readable index;
everything else in the skill explains how to act on what it returns.

**The three-step contract for any management call.**

1. `ocx ready --json` — is the proxy up and admitting requests?
2. `ocx status --json` — is this binary the same version as the running proxy?
   A version mismatch means the help and flags describe a different build (#2701).
3. Then the actual command with `--json`.

**Exit codes.** 0 ok · 2 usage error · 4 not found · 5 conflict · 64 bad args
(`ready` only) · 1 everything else, including transport and 503. Never treat a
printed error with exit 0 as success — that was #2697, and a source scan now prevents
its return.

**Reading failures.** A management failure prints up to three lines: message,
`reason:`, `hint:`. The `reason` is the machine-actionable part. Named 503 classes
worth branching on: `oauth_mutation_busy` and `catalog_busy` (both send
`Retry-After: 1` — retry once), `CONFIG_MUTATION_LOCK_UNAVAILABLE` (a config
mutation holds the lock; retry), and the credential-conflict reason (a broken
install; `ocx doctor` explains it, retrying will not help).

**What an agent must not do.** `POST /api/github/star` has no CLI verb and must not
be driven another way — starring spends the user's identity and needs their consent
(`AGENTS_INSTALL.md`). Same for the session-gated `/api/codex-prompt` writes.
Destructive storage verbs need explicit `--yes`; run the preview and report it first.

**Recipes** (`references/03_recipes.md`), each a real sequence with the JSON field to
read:

- audit the account pool and pause an exhausted account
- switch pool strategy and set a sticky limit
- trace one conversation end to end (`ocx logs --conversation`, then
  `ocx request-history <id> --route-decision`)
- attribute spend per account (`ocx usage --json`, read `accounts[]`)
- rotate an access key and confirm its usage went quiet
- add a provider, test connectivity, make it default
- diagnose "management API unavailable" (ready -> status -> doctor)
- preview and then run a storage cleanup

## 070.4 — docs-site

NEW/MODIFY under `docs-site/`: a CLI reference page generated from the same
capability table, and a changelog entry for the breaking changes this unit lands:

- `doctor` and `sync-cache` now exit non-zero on failure (wp3)
- `account` client error codes now map 404 -> 4 and 409 -> 5 (wp2)
- `--json` is accepted in any argv position, including `ocx restore back --json`
  which previously ignored it (wp3)

Translated locales must not contradict the English source. If a locale cannot be
updated in this phase, leave it untranslated rather than stale.

## 070.5 — AGENTS.md pointer

MODIFY `AGENTS.md`: one line under the commands section pointing at
`skills/ocx/SKILL.md` as the operating-the-proxy reference, distinct from
`AGENTS_INSTALL.md` (installing/operating consent) and this file
(developing the codebase).

## Tests

| File | Assertion |
|---|---|
| `tests/skill-ocx.test.ts` (NEW) | `references/01_management_surface.md` matches regeneration from the capability table; every command named in SKILL.md exists in the table; no recipe references a session-only route |
| `tests/repo-hygiene.test.ts` | the skill directory carries no credential-shaped strings |
| `bun run privacy:scan` | stays green over the new files |

## Accept criteria

1. `skills/ocx/SKILL.md` exists and routes to four references.
2. The surface reference is generated and a test enforces freshness.
3. Recipes cover the eight tasks above and name the JSON fields to read.
4. Failure semantics document exit codes and the named 503 classes.
5. Docs-site has a generated CLI reference and the breaking-change note.

