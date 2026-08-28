# 071 — wp8 implementation record: the `ocx` agent skill

Branch: `codex/ocx-agent-skill`, stacked on `codex/ocx-gui-parity`.
Plan: `070_phase_agent_skill.md`. All five accept criteria met.

## What shipped

```
skills/ocx/
  SKILL.md                              112 lines — orientation, exit codes, consent, routing
  references/
    01_management_surface.md            485 lines — GENERATED from the capability table
    02_json_shapes.md                   125 lines — envelopes and which field to read
    03_recipes.md                       168 lines — eight verified task sequences
    04_failure_semantics.md              84 lines — exit codes, 503 classes, retry policy
scripts/generate-ocx-skill-surface.ts   the generator, with a --check mode
tests/skill-ocx.test.ts                 11 tests
```

Repo-owned rather than `$CODEX_HOME/skills`, because the skill describes *this* repository's CLI
contract and has to version with it. A user-directory copy goes stale the moment the CLI changes.

## The generated half is the point

`01_management_surface.md` is rendered from `src/cli/capabilities.ts` by
`scripts/generate-ocx-skill-surface.ts`, and `tests/skill-ocx.test.ts` asserts the committed file
matches regeneration byte for byte. `bun run skill:surface` writes it; `bun run skill:surface:check`
is what CI asserts.

Hand-writing it would have recreated exactly the defect this unit removed: a second description of
the CLI surface, free to drift from the first. Now a capability added without regenerating fails a
test instead of silently shipping a skill that describes an older build.

Driven red both ways: adding a comment to a capability left the check green (it renders no output),
and changing one `summary` string failed both the `--check` and the test. So the gate tracks content,
not incidental edits.

## The command-existence gate found a real error — in the plan

One test extracts every `ocx <command>` presented as a command across all five pages and asserts each
exists in `CLI_COMMANDS`. It immediately failed on **`ocx request-history`**, which the plan's recipe
section named and which does not exist. The route-decision view is `ocx logs explain <request-id>`.

A skill that documents a command nobody can run is worse than no skill: an agent tries it, gets
`Unknown command`, and concludes the tool is broken.

Two more errors surfaced the same way, from checking against source rather than assuming:

| I wrote | Reality |
|---|---|
| `ocx access key add --label X` | `ocx access key create <name>` — positional |
| `ocx access key remove --id X` | `ocx access key remove <id> --yes` — positional |
| `ocx provider default X` | `ocx provider set-default X` |

### The extractor needed a second pass

A raw prose scan produced two false positives worth recording: "driving ocx **programmatically**"
(an ordinary sentence) and "there is no `ocx request-history` command" — a line whose entire purpose
is to say the command does *not* exist. A gate that fails on documentation warning you about a
missing command is measuring the wrong thing.

The extractor now reads only fenced blocks and inline code spans, skipping spans on lines that
negate them. A companion test asserts it still finds `capabilities`, `ready`, `status`, `logs`,
`usage`, `account`, `storage`, and `inspect` — without that, narrowing the extractor could have made
the main assertion vacuously true.

## Everything in the recipes was executed

Not transcribed from source. `ready`, `status`, `logs --jsonl`, `logs explain`, `access key list`,
`storage report`, `storage cleanup --percent 1`, `inspect star`, `inspect pacing`,
`inspect client-config`, `integration native list`, and `agent request-user-input` were all run
against the live proxy, and the field names in `02_json_shapes.md` were read off those responses.

`logs explain` is where that mattered: the real payload nests everything under `routeDecision` with
`candidates[].exclusions` and `selected.reason`, which is the part an operator actually needs and is
not obvious from the route name.

## Consent, stated rather than implied

`SKILL.md` says plainly not to star the repository on the user's behalf, and says why: the POST
spends *their* GitHub identity and the server requires a dashboard session precisely so an agent
cannot answer that question for them. It also names the workarounds and forbids them — `gh`, a raw
HTTP call, a minted session.

Three tests hold that line: the prohibition must be present, no page may contain `gh api`, and no
page may end a line with a bare `POST /api/github/star`. The failure mode being guarded is a skill
that mentions a boundary and then hands over the workaround anyway.

## Docs-site

`reference/cli.md` gains the exact exit-code table (0/2/4/5/1), the preview-first rule for
`storage cleanup`, an agent-orientation section pointing at `ocx capabilities --json` and
`skills/ocx/`, and a behavior-change list covering this unit: `doctor`/`sync-cache` exiting non-zero,
the 404→4 and 409→5 mapping, position-independent `--json`, `logs --model` actually filtering, and
`ocx storage` gaining subcommands while its bare form is unchanged.

Changes are **additive**, so the seven translated locales are less complete but do not contradict the
English source — which is the plan's stated requirement. Leaving them untranslated is preferred over
machine-translating a contract page.

## AGENTS.md

One pointer added, distinguishing the three audiences: `skills/ocx/` operates a proxy,
`AGENTS_INSTALL.md` installs one, `AGENTS.md` changes the codebase. It also names the regeneration
commands, because a generated file whose generator is undiscoverable gets hand-edited.

## Verification

```
bun test tests/skill-ocx.test.ts tests/repo-hygiene.test.ts tests/cli-capabilities.test.ts
→ 34 pass, 0 fail across 3 files

bun run skill:surface:check → current
./node_modules/.bin/tsc --noEmit → clean
bun run privacy:scan → passed
```

## Subagent dispatch

Sol-tier spawns continued to return 429. The command verification, the three corrected recipe
errors, and the extractor false-positive analysis were done directly.

