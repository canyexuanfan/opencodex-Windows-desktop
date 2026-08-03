# The consequence dialog: design read and exact copy

> **Rev 2** after audit round 1. The Desktop and Codex copy in rev 1 promised
> more than the writers deliver (audit #1, #4, #14); both are rewritten below to
> match the compound-snapshot contract.

Design spec. Implementation lives in `040`; this doc owns the direction and the
strings.

## Design Read

```yaml
---
name: opencodex-consequence-dialog
colors:
  primary: "var(--text)"
  accent: "var(--red)"
  background: "var(--raised)"
typography:
  heading: { fontFamily: inherit, fontSize: var(--text-control) }
  body: { fontFamily: inherit, fontSize: var(--text-caption) }
iconography:
  system: "existing gui/src/icons.tsx set"
  weight: "regular"
  domain: "library-subset"
---
```

Reading this as: a destructive-action confirmation inside an operator control
panel, for a developer who already knows what these clients are and needs to
know what breaks. Closer to a package manager's "the following will be removed"
than to a consumer app's "are you sure?" — the value is in the specifics, and
every sentence that is not a specific is noise.

Do's: name the literal path; say what stops working in the user's words, not
ours; state undo honestly including when it is imperfect.
Don'ts: no generic "이 작업은 되돌릴 수 없습니다" boilerplate, no red-splash
alarm styling, no emoji, no motion.

```
DESIGN_VARIANCE: 2
MOTION_INTENSITY: 1
Product density profile: D5
Reasoning: dashboard/admin preset is V3/M2/D5; a destructive confirmation drops
variance one further because ornament competes with the facts the user must read
before deciding.
```

Concept generation (UX-CONCEPT-GEN-01) is **skipped**: utility dashboard surface
under an existing design system, which the skill names as an explicit skip.

## Lazy-user gate (UX-LAZY-01)

Ran the ladder honestly, because a confirmation dialog is exactly the kind of
decision point this gate exists to delete:

1. **Do nothing** — can a default remove the decision? No. The user is asking to
   change state on their own machine; there is no default that does it for them.
2. **Delete** — does it earn its cost? For three of the four, yes: they mutate
   files outside opencodex that other programs read. For **Claude Code, no** —
   it flips one boolean in our own config, breaks nothing on disk, and is undone
   by flipping it back. A confirmation there is pure friction.
3. **Absorb** — can the system take the complexity? Partly: the snapshot IS the
   absorption. It is what lets the dialog say "undoable" instead of "careful".
4. **Demote** — the path and the technical detail are the second line, not the
   headline.

**Decision: three dialogs, not four.** Claude Code toggles immediately. This is
a deliberate asymmetry and the reason is on-disk blast radius, not caution
level.

## Structure

Four slots, always in this order, because it is the order the questions occur:

1. **Title** — the action and its target. "Grok Build 연동을 해제할까요?"
2. **What changes** — the literal path and the literal edit.
3. **What stops working** — in the user's terms.
4. **Undo** — honest, including "we cannot restore X".
5. **Side effects** — only rendered when there are any. An always-present empty
   row trains the eye to skip the position.

Confirm button names the action ("해제", "복원") — never "확인". A user who
skims the buttons should still know what they pressed.

## The copy (Korean source; other five locales translate from this)

### Codex

> **Codex 연동을 해제할까요?**
>
> `~/.codex/config.toml`과 `~/.codex/opencodex.config.toml`에서 opencodex가 쓴
> 부분을 제거하고, 모델 카탈로그를 백업본으로 되돌립니다.
>
> 해제하면 `codex`가 프록시를 거치지 않고 OpenAI로 직접 붙습니다. opencodex에
> 연결한 다른 제공자 모델은 Codex에서 사라집니다.
>
> 되돌릴 수 있습니다. 설정 파일, 프로필, 모델 카탈로그를 바꾸기 전에 함께
> 보관하며, 복원 센터에서 되살릴 수 있습니다. 다만 이전 대화 기록의 제공자
> 표시는 복원 대상이 아닙니다.
>
> 이미 실행 중인 Codex 세션은 바로 바뀌지 않을 수 있습니다. 새로 시작하세요.

The undo paragraph names the three artifacts the compound snapshot actually
covers and excludes the one it does not (`state_5.sqlite` history tagging,
`010` §The specs). Rev 1 said "적용 전 원본을 journal에 보관해 두었고" — which
pointed at a file `restoreNativeCodex` deletes on a complete restore, so the
promise would have expired exactly when it was needed.

That last line is load-bearing: `app-server-processes.ts:546` proves a long-lived
app-server holds state in memory, and nothing proves it re-reads
`openai_base_url`. Promising an instant switch would be a lie we can't back.

### Claude Desktop

> **Claude Desktop 연동을 해제할까요?**
>
> `<configLibrary>/<id>.json`을 지우고 `_meta.json`의 opencodex 항목을
> 제거합니다. Desktop이 이 프로필을 쓰고 있었다면 남아 있는 다른 프로필로
> 넘깁니다.
>
> 해제하면 Claude Desktop에서 opencodex로 연결한 모델을 더는 쓸 수 없습니다.
>
> 되돌릴 수 있습니다. 프로필과 `_meta.json`을 함께 보관하므로, 복원하면
> Desktop이 쓰던 프로필 선택까지 그대로 돌아옵니다.

Rev 1's last paragraph — "이전에 어떤 프로필을 쓰고 있었는지는 기록이 없어 알 수
없습니다" — is DELETED, and it is the clearest sign the audit was right. It was
true only because rev 1 snapshotted `_meta.json` without the profile. The
compound snapshot holds both, so restore genuinely returns the previous
selection, and the copy can now say so honestly.

The `no_safe_desktop_fallback` case never reaches this dialog: it is refused at
preflight, before the user is asked to confirm anything.

The last paragraph is the honest cost of a gap in the original design: apply
overwrote `appliedId` without recording what was there. We say so rather than
silently picking one and letting the user discover it.

### Grok Build

> **Grok Build 연동을 해제할까요?**
>
> `~/.grok/config.toml`에서 opencodex가 표시해 둔 블록만 제거합니다. 블록
> 바깥에 직접 쓴 내용은 그대로 둡니다.
>
> 해제하면 Grok Build에서 opencodex 모델 별칭이 사라집니다. xAI 계정으로 쓰던
> 모델은 그대로입니다.
>
> 되돌릴 수 있습니다. 제거 전 파일 전체를 보관하며, 복원 센터에서 되살릴 수
> 있습니다.

No side-effect line: nothing else depends on the fence.

### Claude Code — no dialog

Toggles immediately, per the lazy-user gate. If a user turns it off by accident
they turn it back on; nothing on disk moved.

## Refusals are not dialogs

A refusal arrives AFTER the user already confirmed, so it belongs in the card's
notice area, next to the switch that failed — not in a second modal. Three
specific ones, each stating the state and the one thing that would change it:

- **Grok `orphaned-marker`** — "`~/.grok/config.toml`에 opencodex 시작 표시는
  있는데 끝 표시가 없습니다. 어디까지가 우리 블록인지 확신할 수 없어 파일을
  건드리지 않았습니다." No "try again": retrying is exactly what will not help.
- **Home mismatch** — names both recorded and current homes. Do NOT say "stop
  the service": the trigger is a home mismatch, not a running service (`001`
  §The guard I described wrong).
- **`no_safe_desktop_fallback`** — "opencodex 프로필이 Claude Desktop의 유일한
  프로필입니다. 이것만 지우면 Desktop이 쓸 프로필이 없어져, 아무것도 바꾸지
  않았습니다. Desktop에서 다른 프로필을 만든 뒤 다시 시도해 주세요."
- **`unowned_profile`** — "opencodex라는 이름의 Desktop 프로필이 있지만 이
  설치가 만든 것이라고 확인할 수 없어 건드리지 않았습니다."
- **`partial`** — the one case that is not a refusal: some artifacts changed and
  could not be put back. It names every residual path and points at the Rollback
  Centre entry, because a half-changed state with no handle is the worst outcome
  this unit can produce.
- **Codex owned by another provider** — "Codex가 opencodex가 아닌 다른 제공자로
  설정돼 있습니다. 그쪽 설정은 건드리지 않았습니다."

## Verification

A dialog is a render artifact, so C runs the render-grounding loop
(C-RENDER-GROUNDING-01): open each of the three in the real browser, screenshot,
read the screenshot back, and assert the rendered text — not just that a modal
with the right test id mounted.
