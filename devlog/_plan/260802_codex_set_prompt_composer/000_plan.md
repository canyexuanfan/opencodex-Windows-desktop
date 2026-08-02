# 000 — Codex Set: the prompt composer

Unit: `devlog/_plan/260802_codex_set_prompt_composer/`
Opened: 2026-08-02 · Work class: C4 · Branch target: `dev`
Base commit for every opencodex citation: `f9b9440c5` ("release: v2.10.0").
Base commit for every upstream citation: `2b5bdcf67` in
`/Users/jun/developer/codex/121_openai-codex` ("Support portable Agent Plugins
throughout installation (#36544)"), pulled 2026-08-02.

## Objective

Turn the `Codex Auth` tab into `Codex Set` — a page that configures Codex as a
whole, not just its accounts — and give it a second section that composes the
Codex prompt stack.

Verbatim ask, decomposed:

1. "codex auth 탭 이름을 codex set로 바꾸고, 현재 창은 multi-auth로 바꾸고"
   — the page becomes `Codex Set`; today's account-pool content becomes its
   `Multi-auth` section.
2. "그 옆에 codex prompt, 아니 뭐 prompt, 그냥 prompt 이렇게 넣고" — a second
   section named `Prompt`.
3. "상단 로그 디버그 탭처럼 왼쪽, 오른쪽 창을 이동하는 걸로" — the Logs/Debug
   tab pattern, not the scrolling section-tabs pattern. See §Layout decision.
4. "계층적으로 들어가는 프롬프트를 스위치로 껐다 켰다" — each built-in prompt
   layer gets a switch.
5. "우리가 추가하는 레이어들을 플러스로 이제 넣을 수 있도록" — a `+` affordance
   adds custom layers.
6. "기존 프롬프트는 스위치를 끄고, 그 행을 삭제하는 건 불가능하지만" — built-in
   rows can be switched off but never deleted.
7. "커스텀으로 넣는 프롬프트는 팝업이 떠서 그 안에 프롬프트를 삽입하고,
   저장하고, 스위치를 껐다 킬 수 있고, 그 행 자체를 삭제할 수도" — custom rows
   open an editable dialog and can be deleted.
8. "기본적으로 있는 프롬프트는 팝업으로 열리지만 편집 불가능하게" — built-in
   rows open a read-only dialog.
9. "절대 끌 수 없는 프롬프트는 프롬프트 설정창에서 절대 끌 수 없게 만들어놔" —
   layers with no upstream off-switch must render as permanently on. This is the
   single hardest constraint in the unit and §4 of `001` proves which layers
   those are.
10. "클로드 코드의 프리셋을 제공한다든지, 아니면 Grok Build의 시스템 프롬프트를
    제공한다든지" — ship presets, "codex 호환성이 있게 우리가 좀 조작을 해서".
11. "theme도 넣는데 ... 나중에 하는 걸로 그냥 설계해가지고 별도 devlog로 그냥
    잠깐 스텝만 남겨놓고" — Theme is deferred; a separate stub unit records the
    steps, and nothing in this unit implements it.

"굳이 이게 완성본이지 않고, 우리는 일단 기능만 제공하고 나중에 유저 피드백을
받아서" — ship the whole feature, expect the shape to move on feedback.

## Evidence base

Four parallel read-only researchers, all against the two frozen HEADs above:

| Lane | Question | Document |
|---|---|---|
| Noether | Every prompt layer, its gate, its default | `001` |
| Herschel | AGENTS.md path, `model_instructions_file`, preset sources | `002` |
| Parfit | config.toml load order, write safety, when edits apply | `003` |
| Raman | opencodex GUI/API/test surfaces to reuse | `004` |

## The finding that reshapes the design

The ask assumes custom layers are "plus" additions next to the built-ins. The
obvious mechanism — `model_instructions_file` — **replaces the entire base
prompt** rather than adding to it (`002` §3). Wiring the `+` button to it would
silently delete Codex's own instructions the moment a user saved their first
custom layer.

The additive key is `developer_instructions`: a root string that renders as its
own developer-role section ahead of world-state content
(`config_toml.rs:216`, `session/mod.rs:3413`). So:

- **Custom layers compose into `developer_instructions`**, concatenated in row
  order, each wrapped in a marker comment carrying its row id.
- **`model_instructions_file` is not written by the `+` flow at all.** It
  appears in the Prompt section only as a read-only *status* row that reports
  whether something outside opencodex has replaced the base prompt.

This is a deviation from the literal ask and is called out here rather than
buried: the requested capability ships, through a different key, because the
obvious key destroys what the user wanted to keep.

## Layout decision

The ask names the Logs/Debug tab as the model. `004` §A3 establishes that Logs
does **not** use `SectionTabs` (the sticky scroll-spy strip on Usage / Subagents
/ API Keys). It swaps exclusive tabpanels and persists the choice in the hash
(`#logs` vs `#logs/debug`), lazy-mounting Debug on first visit
(`Logs.tsx:408-425`, `Logs.tsx:551`).

That is the right pattern here and matches "왼쪽, 오른쪽 창을 이동하는" more
precisely than a scrolling page would: Multi-auth and Prompt are unrelated
surfaces, and Multi-auth polls `/api/codex-auth/*` on a 30s timer that should
not run while the user is editing prompts.

Decision: **exclusive tabpanels, hash-persisted, Logs-shaped.**
`#codex-set` = Multi-auth, `#codex-set/prompt` = Prompt.

## Route identity

`004` §A1 flags this as UNKNOWN in the ask. Decision: **rename the route id to
`codex-set`** and add `codex-auth` → `codex-set` to the existing legacy-redirect
table (`app-routing.ts:85-93`) so bookmarks and the Providers deep link
(`providers-page-utils.ts:19`) keep working.

The backend namespace `/api/codex-auth/*` **does not move**. It is load-bearing
across a dozen test files and renaming it buys nothing.

## Constraints

| Constraint | Source |
|---|---|
| Layers with no upstream off-switch must be non-disableable in the UI | Ask item 9; proven set in `001` §4 |
| Custom text never routes through `model_instructions_file` | `002` §3 |
| Writes must preserve user comments and formatting | `003` §4; `features.ts:262` precedent |
| Only marker-owned lines may be rewritten or deleted | `injected-marker.ts:53-60` |
| Copy says "applies to new sessions", never "next turn" | `003` §3 |
| Presets are adapted, never pasted verbatim | `002` §5-6 |
| A key opencodex does not recognise is left untouched, not deleted | `003` §5 |
| No secret, token, or account identifier is ever serialized | AGENTS.md privacy boundary |
| `bun run typecheck`, `bun run test`, `privacy:scan`, `lint:gui` stay green | AGENTS.md |

## Work phases

One decade doc per phase; one PABCD cycle per decade doc.

| Phase | Doc | Deliverable |
|---|---|---|
| WP1 | `010` | `src/codex/prompt-layers.ts` — read/write the toggles and the composed custom block |
| WP2 | `020` | `/api/codex-prompt` GET/PUT route + registration |
| WP3 | `030` | Page shell: rename, tabpanels, hash routing, legacy redirect, i18n |
| WP4 | `040` | Prompt section: layer rows, switches, read-only dialog |
| WP5 | `050` | Custom layers: `+`, editable dialog, delete, reorder |
| WP6 | `060` | Presets + the compatibility linter |
| WP7 | `070` | Docs sync, locale parity, full-gate verification |

Deferred, stub only: `090` (Theme).

## Out of scope

- Theme (recorded in `090`, implemented later).
- Any change to `/api/codex-auth/*`.
- Any change to how opencodex proxies requests. This unit writes Codex's own
  config; it does not touch the proxy's prompt handling.
- Editing AGENTS.md files. The Prompt section reports the AGENTS.md layer but
  never writes project docs.
