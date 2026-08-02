# 001 — The Codex prompt stack, layer by layer

Researcher: Noether (read-only). Upstream HEAD `2b5bdcf67`.
Every row below was read in `/Users/jun/developer/codex/121_openai-codex`.

## 1. Assembly order

Sections are registered by `add_section()` in `codex-rs/core/src/session/world_state.rs`.
Initial-context rendering preserves that order with two exceptions: model-switch
moves to the front and multi-agent mode to the back of the developer-message
sequence (`session/mod.rs:3528-3538`).

| # | Layer | Tag | Role | Gate | Default | Class |
|---:|---|---|---|---|---|---|
| 1 | Model instructions | `<model_switch>` | dev | none | — | **ALWAYS-ON** |
| 2 | Personality | `<personality_spec>` | dev | `[features] personality` | on | FEATURE |
| 3 | Context-window guidance | `<context_window_guidance>` | dev | `[features] token_budget` | off | FEATURE |
| 4 | Realtime | `<realtime_conversation>` | dev | none | — | **ALWAYS-ON** |
| 5 | AGENTS.md | `<INSTRUCTIONS>` | user | none | — | **ALWAYS-ON** |
| 6 | Permissions | `<permissions instructions>` | dev | `include_permissions_instructions` | on | **TOGGLE** |
| 7 | Collaboration mode | `<collaboration_mode>` | dev | `include_collaboration_mode_instructions` | on | **TOGGLE** |
| 8 | Environment context | `<environment_context>` | user | `include_environment_context` | on | **TOGGLE** |
| 9 | Environments instructions | `<environments_instructions>` | dev | `include_environment_context` AND `[features] deferred_executor` | off | FEATURE |
| 10 | Apps | `<apps_instructions>` | dev | `include_apps_instructions` + connector present | on | **TOGGLE** |
| 11 | Plugins | `<plugins_instructions>` | dev | plugin availability | — | FEATURE |
| 12 | Tools | `<tools>` | dev | `[features] deferred_tool_world_state` | off | FEATURE |
| 13 | Skills (extension) | `<skills_instructions>` | dev | `[skills] include_instructions` | on | **TOGGLE** |
| 14 | Multi-agent mode | `<multi_agent_mode>` | dev | `[features.multi_agent_v2] enabled` | off | FEATURE |

Line references, in registration order: `world_state.rs:61`, `:66`, `:88`,
`:99`, `:113`, `:114`, `:139`, `:149`, `:168`, `:175`, `:187`, `:190`, `:208`,
`:228`.

Ordering caveat: Skills is an *extension* contribution, so its position among
other extensions depends on registration order. Statically guaranteed is only
that all extension contributions land between Tools and Multi-agent mode
(`world_state.rs:187`, `:208`, `:228`). The UI must therefore not promise an
exact index for Skills.

## 2. The five direct off-switches

These are the only keys that turn a layer off without side effects. All five
default to on when unset.

| Key | TOML position | Resolves at |
|---|---|---|
| `include_permissions_instructions` | root | `config/mod.rs:3836` |
| `include_apps_instructions` | root | `config/mod.rs:3837` |
| `include_collaboration_mode_instructions` | root | `config/mod.rs:3838` |
| `include_environment_context` | root | `config/mod.rs:3845` |
| `[skills] include_instructions` | `[skills]` table | `config/mod.rs:3840` |

Declared as `Option<bool>` at `config_toml.rs:220-229` and `skills_config.rs:30`;
`unwrap_or(true)` at the resolve sites above.

## 3. Feature-gated layers

Reachable from config.toml, but through `[features]` rather than an `include_*`
key, and turning them off changes more than prompt text. The Prompt section
shows these as **status rows, not switches** — flipping `multi_agent_v2` from a
prompt page would silently reconfigure subagent concurrency.

`personality` (default on, `features/lib.rs:1373`), `token_budget` (off,
`:1337`), `deferred_executor` (off, `:883`), `plugins` (on, `:1181`),
`deferred_tool_world_state` (off, `:1151`), `multi_agent_v2` (off, `:1097`).

## 4. The canonical taxonomy — five classes, not two

An earlier draft of this section carried a single "cannot be turned off" list.
An independent audit found it self-contradictory: it listed Plugins as
feature-gated in §3 and simultaneously as non-disableable here, and it conflated
"has no `include_*` key" with "cannot be suppressed at all". Both errors would
have propagated straight into the API's `locked` array.

Every layer belongs to exactly **one** of these classes. This taxonomy is the
single source for `020`'s response and `040`'s row kinds; a contract test
asserts the partition is total and disjoint.

### Class A — `base` — the request's own instruction field

| id | Layer | Why it is class A |
|---|---|---|
| `base-instructions` | base/model instructions | the outbound request always carries non-empty base instructions (`client.rs:861-887`); no `include_base_instructions` exists. Content is replaceable via `model_instructions_file`; presence is not. |

Exactly one member. It is not a world-state section at all — it travels in the
Responses `instructions` field.

### Class B — `config-toggle` — a direct boolean in config.toml

`permissions`, `collaboration`, `environment`, `apps`, `skills`. The five keys
of §2. **These are the only rows that get a switch.**

### Class C — `feature-gated` — reachable, but through `[features]`

| id | Governing key | Default |
|---|---|---|
| `personality` | `[features] personality` | on |
| `context-window-guidance` | `[features] token_budget` | off |
| `environments-instructions` | `[features] deferred_executor` | off |
| `plugins` | `[features] plugins` | on |
| `tools` | `[features] deferred_tool_world_state` | off |
| `multi-agent-mode` | `[features.multi_agent_v2] enabled` | off |

**Plugins belongs here, not in the non-disableable set.** `session/mod.rs:3422-3430`
checks `Feature::Plugins` when building plugin context. The audit was right; the
earlier draft was wrong. What is true is narrower: there is no
`include_plugins_instructions` key. That makes it feature-gated, not immovable.

Class C rows get **no switch** — flipping `multi_agent_v2` from a prompt page
would silently reconfigure subagent concurrency — but they are honestly labelled
as configurable elsewhere, with a link to the setting that owns them.

### Class D — `runtime-conditional` — no config gate, presence follows state

| id | Emits when | Evidence |
|---|---|---|
| `model-switch` | the model changed and instructions are non-empty | `model.rs:44-58` |
| `agents-md` | discovered project docs produced content | `world_state.rs:113`, `agents_md.rs:89-110` |
| `realtime` | entering or leaving active realtime | `realtime.rs:43-66` |

No boolean anywhere suppresses these. They can still be *empty* — a zero
`project_doc_max_bytes` yields no AGENTS.md content — but emptiness is not a
toggle, and the UI must not present it as one.

### Class E — `extension-unknown`

Core iterates registered extension contributors unconditionally
(`world_state.rs:208`), but each extension decides its own availability. So the
honest claim is "no *core* include switch", not "cannot be turned off" — the
audit flagged the stronger wording as overstated and it is.

Skills is the one extension with a known config gate and therefore sits in class
B. Every other extension layer is class E: enumerable only at runtime, if at
all.

### What "locked" means on the wire

`020`'s `locked` array is **classes A and D only** — the rows where a switch
cannot exist. Class C rows are `features`. Class E is reported as a count, not a
list, because we cannot enumerate it.

Ask item 9 — "절대 끌 수 없는 프롬프트는 절대 끌 수 없게" — is satisfied by
classes A and D. That is the set the tests in `020` case 5 and `040` case 2
defend.

## 5. Content-override keys

| Key | Position | Semantics |
|---|---|---|
| `model_instructions_file` | root / profile, path | **REPLACES** base instructions (`config/mod.rs:3825-3832`) |
| `instructions` | root, string | legacy base override, below the file key |
| `developer_instructions` | root, string | **ADDS** a developer section before world state (`session/mod.rs:3413`) |
| `experimental_compact_prompt_file` | root / profile, path | replaces the compaction prompt only |
| `experimental_realtime_start_instructions` | root, string | replaces realtime start text |
| `[features.multi_agent_v2] subagent_developer_instructions` | table, string | replaces inherited subagent dev instructions |
| `[features.multi_agent_v2] multi_agent_mode_hint_text` | table, string | empty string suppresses layer 14 |
| `[features.token_budget] guidance_message` | table, string | supplies layer 3's body |
| `[auto_review] policy` | table, string | augments the guardian template |

Not valid config.toml keys at this HEAD: `base_instructions` (runtime override
only, `config/mod.rs:2566`), `experimental_instructions_file` (removed
2026-05-14 in `7dbe1c949`), root `guardian_policy_config` (managed
`requirements.toml` only).

`developer_instructions` is the key WP5 composes into. It is the only root
string that adds a layer instead of replacing one.

## 6. Version sensitivity

This surface is young and still moving. Landing dates from pickaxe history:

- `include_apps_instructions`, `include_permissions_instructions`,
  `include_environment_context` — `8d1964686` / `91ca49e53`, 2026-04-03.
- `include_collaboration_mode_instructions` — `8123bddb1`, 2026-05-12.
- `experimental_instructions_file` **removed** — `7dbe1c949`, 2026-05-14.
- `subagent_developer_instructions` — `49025589b`, 2026-07-28.
- Skills moved out of core to an extension — `0d109f097`, 2026-07-31.
- Environment-context behavior last changed — `9eeac78b3`, 2026-07-30.

Consequence for the implementation: treat every key as possibly-absent. WP1
reads what is there and reports the rest as unknown rather than asserting a
default the running Codex may not share.

## Needs verification

- Skills' index relative to other extensions is registration-order dependent;
  only the Tools→Multi-agent bracket is static.
- Third-party extensions may add further layers with their own gates. The UI
  must not claim its list is exhaustive.
