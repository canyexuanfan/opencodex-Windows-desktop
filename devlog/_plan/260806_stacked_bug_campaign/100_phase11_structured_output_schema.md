# 100 — Phase 11: routed structured-output schema preservation (PR #985)

Credit: **Pranav Yerramaneni** (`devmello <pranavy2008@gmail.com>`), PR #985.
Adoption: **adapted** — one schema-loss bug closed.

## Defect

Structured output (`response_format` / `text.format`) was dropped when routing
to `openai-chat` models, so a client asking for a JSON schema got free text.

## Why adapted

The parser/adapter/compaction architecture in #985 is correct and stays. One
real bug remains: `src/adapters/openai-chat.ts:827-840` drops `json_schema`
entirely when `schema` is absent. A schema-less `json_schema` is a valid
request shape — dropping it silently reintroduces the very defect the PR fixes,
just on a narrower input.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/adapters/openai-chat.ts` | MODIFY | `:827-840` — accept `json_schema` even when `schema` is absent; add the `schema` member conditionally instead of discarding the format |
| `src/responses/parser.ts`, compaction path | KEEP | As authored in #985 |
| `tests/*structured-output*.test.ts` | MODIFY | Add the schema-less `json_schema` case alongside the authored cases |
| `docs-site/src/content/docs/reference/proxy-formats.md` | KEEP | `:141-146` wording is already correct |

## Verification

- `bun test` on the structured-output and openai-chat adapter suites
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 10, base = stack 09 head. Credits Pranav Yerramaneni.
