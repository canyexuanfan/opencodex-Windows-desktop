# 070 — WP7: i18n, docs-site sync, hardening

Diff-level PRD. Depends on WP1-WP6. This is the closing phase: it makes the
surface speak six languages, tells users the truth in the docs, and runs the
full gate rather than the per-phase subset.

## Scope boundary

IN

- `gui/src/i18n/{en,de,ko,zh,ru,ja}.ts` — MODIFY (every new key, six files).
- `docs-site/` — MODIFY (Integrations page + the client matrix).
- `src/cli/help.ts` — MODIFY (`ocx export --client` list now names six clients).
- `tests/` — MODIFY (full-suite green; add the cross-cutting invariants below).

OUT

- No new features. A behavior change discovered here is a WP-amendment
  (LOOP-UNIT-CHAIN-01), not a silent extension.

## 1. i18n — the six-file obligation

`TKey = keyof typeof en` (005 §5), and every non-English dictionary is
`Record<TKey, string>`. So a key added to `en.ts` **breaks the build** until
all five others have it. That is the enforcement; this phase just does the work
deliberately instead of discovering it at typecheck.

Key groups (English + Korean given here as the source of tone; the other four
follow their existing register):

| Key | en | ko |
|---|---|---|
| `nav.integrations` | Integrations | 연동 |
| `integrations.tab.overview` | Overview | 개요 |
| `integrations.tab.keys` | API Keys | API 키 |
| `integrations.state.absent` | Not applied | 미적용 |
| `integrations.state.current` | Applied | 적용됨 |
| `integrations.state.stale` | Update available | 업데이트 필요 |
| `integrations.state.conflict` | Conflict | 충돌 |
| `integrations.state.unsafe` | Cannot verify | 확인 불가 |
| `integrations.state.notInstalled` | Not installed | 미설치 |
| `integrations.action.apply` | Apply | 적용 |
| `integrations.action.disable` | Disable | 해제 |
| `integrations.action.undo` | Undo | 되돌리기 |
| `integrations.action.restore` | Restore from backup… | 백업에서 복원… |
| `integrations.action.restorePoint` | Restore to this point… | 이 시점으로 복원… |
| `integrations.journal.expired` | Backup expired | 백업 만료됨 |
| `integrations.journal.empty` | No apply history yet | 아직 적용 기록이 없습니다 |
| `integrations.caveat.comments` | Comments in this file are not preserved | 이 파일의 주석은 보존되지 않습니다 |
| `integrations.refuse.conflict` | This file changed after opencodex wrote it | opencodex가 쓴 뒤 파일이 변경되었습니다 |
| `integrations.refuse.nonLoopback` | Remote binds need a key you must enter yourself | 원격 바인드는 직접 키를 입력해야 합니다 |
| `integrations.applyNote.openclaw` | Applies to the running gateway immediately | 실행 중인 게이트웨이에 즉시 반영됩니다 |
| `integrations.applyNote.hermes` | Applies to new sessions | 새 세션부터 적용됩니다 |
| `integrations.applyNote.gajae` | Applies to new sessions, or when you open /model | 새 세션 또는 /model을 열 때 적용됩니다 |
| `integrations.applyNote.kimi` | Applies on restart or /reload | 재시작 또는 /reload 시 적용됩니다 |

The four verbs are fixed (004 §6): 적용 / 해제 / 되돌리기 / 복원. No fifth verb
may enter the dictionary — a reviewer checks this by grepping the new keys.

**Rule: `nav.api`, `nav.claude`, `nav.grok` are NOT deleted** in this phase.
They still label the sub-tabs. Deleting them would be a separate, riskier
change and the keys cost nothing.

**Activation scenario:** run `cd gui && bun run lint:i18n` and
`bun run build:gui`; a missing locale key is a compile error, which is the
observable proof the obligation is enforced rather than documented.

## 2. docs-site sync (SOT-SYNC-01)

`docs-site/` gets one new page under the existing guide structure:

- What the Integrations tab does, with the six file-toggle clients named and
  the four exception clients explained (they are not switches).
- The per-client table: config path, format, when the change takes effect,
  and whether the credential is an env reference or a loopback placeholder.
- The rollback contract in user terms: every apply backs up first; undo
  applies to the newest operation; restore asks before replacing later edits;
  10 backups per client are kept.
- The honest caveats: comments are not preserved for YAML/JSON5/TOML clients;
  Kimi is loopback-only; OpenCode launched via `ocx opencode` takes its config
  from the launcher, not from disk (004 §4).

Translated locales must not contradict the English source; where a locale is
not updated, it links to the English page rather than shipping a stale claim.

## 3. CLI surface

`ocx export --client <id>` already derives its usage list from
`EXPORT_CLIENT_IDS` (005 §1), so the six ids appear automatically. What needs
a deliberate edit is `src/cli/help.ts`, whose prose says "opencode/Pi":

```diff
-  ocx export --client <id>    Print an opencode/Pi config wired to the running proxy
+  ocx export --client <id>    Print a client config wired to the running proxy
```

and the `export` command's `usage` string, which hardcodes
`<opencode|pi>` today.

## 4. Cross-cutting hardening tests

These belong here rather than in an earlier phase because they assert
properties *across* the whole feature:

| Test | Asserts |
|---|---|
| `every registry client has a GUI label key` | `EXPORT_CLIENT_IDS` ⊆ `CLIENT_LABEL_KEYS` keys — catches the hand-synced tuple drifting (005 §1) |
| `every state has a badge key` | the five states + `notInstalled` all resolve in `en` |
| `no client config output contains a credential` | all six clients, real-looking key in config, assert absent |
| `the four-verb vocabulary holds` | new i18n keys contain no fifth action verb |
| `journal never stores file content` | a journal row's fields are paths/hashes/timestamps only |

## 5. Full gate (the phase's own accept criteria)

1. `bun run typecheck` — clean.
2. `bun run test` — full suite green (not just touched files).
3. `cd gui && bun test tests` — GUI suite green (root `bun run test` does not
   include it; 005 §5).
4. `bun run lint:gui` — clean.
5. `bun run build:gui` — succeeds (this is what actually proves the six
   locales are complete).
6. `bun run privacy:scan` — no new findings attributable to this unit.
7. Docs-site builds.

## 6. Definition of done for the whole feature

A reviewer can, on a clean checkout:

- start the proxy, open the GUI, land on Integrations, and see six clients
  with honest states (including `미설치` for absent ones);
- toggle one on, confirm the client's config gained exactly one provider
  block and nothing else changed;
- toggle it off, confirm the block is gone and the rest of the file is
  byte-identical to before the apply;
- hand-edit the file, confirm the switch locks and disable refuses;
- restore from the rollback center and get the pre-apply file back.

## OPEN QUESTIONS

- Whether the docs-site page should carry the per-client "verified against
  version X" line. It is honest but goes stale; the alternative is a dated
  research link back to `002`. Recommend the dated link.
- Whether `nav.api`/`nav.claude`/`nav.grok` should eventually be renamed to
  `integrations.tab.*` for consistency — a cosmetic follow-up, not this unit's
  work.
