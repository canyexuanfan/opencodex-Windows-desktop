# Codex App / codex-rs findings

## Summary

The sidebar disappearance is caused by two independent filters in Codex App / app-server:

1. Provider filter: when `model_providers` is omitted, app-server defaults to the active configured provider.
2. Source filter: when `source_kinds` is omitted or empty, app-server defaults to `INTERACTIVE_SESSION_SOURCES`.

In the local codex-rs checkout at `/Users/jun/Developer/codex/codex-cli/codex-rs`, `INTERACTIVE_SESSION_SOURCES` is:

```text
cli
vscode
custom atlas
custom chatgpt
```

It does not include `exec`.

## Source anchors

codex-rs source anchors:

- `/Users/jun/Developer/codex/codex-cli/codex-rs/rollout/src/lib.rs`
  - `INTERACTIVE_SESSION_SOURCES` includes `Cli`, `VSCode`, `Custom("atlas")`, `Custom("chatgpt")`.
- `/Users/jun/Developer/codex/codex-cli/codex-rs/app-server/src/filters.rs`
  - `compute_source_filters(None)` returns `INTERACTIVE_SESSION_SOURCES`.
  - `compute_source_filters(Some(Vec::new()))` also returns `INTERACTIVE_SESSION_SOURCES`.
  - `ThreadSourceKind::Exec` requires an explicit source filter.
- `/Users/jun/Developer/codex/codex-cli/codex-rs/app-server/src/request_processors/thread_processor.rs`
  - `model_providers: None` becomes `Some(vec![self.config.model_provider_id.clone()])`.
  - `source_kinds` flows through `compute_source_filters()`.
  - Those filters are passed to `thread_store.list_threads()`.
- `/Users/jun/Developer/codex/codex-cli/codex-rs/state/src/runtime/threads.rs`
  - SQL filter applies `threads.archived = 0`, `threads.preview <> ''`, optional `threads.source IN (...)`, optional `threads.model_provider IN (...)`, and optional `threads.cwd IN (...)`.

## Local DB evidence

Read-only query against `/Users/jun/.codex/state_5.sqlite` for project cwd `/Users/jun/Developer/new/700_projects/opencodex`:

| model_provider | source | count |
| --- | --- | ---: |
| `openai` | `cli` | 7 |
| `openai` | `exec` | 2 |
| `opencodex` | `exec` | 43 |
| `opencodex` | subagent thread-spawn JSON | 2 |

Default Codex App list while opencodex is active:

```sql
WHERE archived = 0
  AND preview <> ''
  AND source IN ('cli', 'vscode', 'atlas', 'chatgpt')
  AND model_provider = 'opencodex'
```

That returns zero rows locally because opencodex-created project rows are `source = 'exec'`.

## Upstream patch direction

The cleaner upstream fix would be in Codex App / codex-rs:

- either request `sourceKinds` including `exec` for the project sidebar,
- or make the project sidebar intentionally provider/source agnostic when the user is browsing project history,
- or expose a UI affordance for source filtering.

opencodex cannot change Codex App's `thread/list` request payload. The opencodex-side fix therefore must be an explicit compatibility mode that temporarily adjusts local metadata and restores it later.

## opencodex fix direction

For `syncResumeHistory: true`:

- backup original thread metadata into `~/.opencodex/codex-history-backup.json`;
- remap old OpenAI `cli`/`vscode` rows to `model_provider = 'opencodex'`;
- promote opencodex-created user `exec` rows to `source = 'cli'`;
- update the rollout JSONL first `session_meta` line consistently so Codex's rollout scanner does not repair the DB back to the hidden state;
- on `ocx stop` / `ocx restore`, restore only rows recorded in the backup manifest.

Default remains unchanged: no history mutation unless the user explicitly enables `syncResumeHistory`.

## Legacy PR #13 upgrade edge

There is one unsafe-to-automate edge case:

1. A user enabled `syncResumeHistory: true` on a development build before backup support existed.
2. That build remapped old `openai` interactive rows to `opencodex`.
3. The user upgrades while those rows are still remapped.
4. The new backup manifest does not exist, so `ocx stop` cannot know which `opencodex` interactive rows were originally OpenAI rows.

The fix must not silently rewrite all `opencodex` `cli`/`vscode` rows to `openai`, because future or app-created rows can legitimately be opencodex-owned. Instead:

- normal `ocx stop` detects and reports ambiguous unbacked rows;
- it leaves them unchanged by default;
- `ocx recover-history --legacy-openai` is the explicit manual recovery path for users who know those rows came from the old remap.
