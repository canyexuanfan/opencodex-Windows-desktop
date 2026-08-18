# WP7 — Wave 5C: Cursor train

```
#1900 → #1895 → (#1887 ⊕ #1896) → #1903 → #1866
```

## #1900 — nested tools, clean EOF, GetUsableModels, cmd/command (head 1824a0148)

Normalizes Cursor request/tool/result shape. Gates before merge:

- non-loopback discovery is HTTPS-only; loopback HTTP is the only exception
- a Bearer credential is refused before it can leave over plain HTTP to a
  remote endpoint
- clean EOF counts as success only with no open tool call; EOF with an
  unfinished tool call is a protocol error
- #1866 stays open — #1900 explicitly scopes it out

## #1895 — code-mode nested helpers in the shared catalog nudge (CHANGES_REQUESTED)

Guidance must be generated from the actually advertised catalog. Hardcoding
`exec`, `read_file` and friends re-introduces per-provider drift, which is the
defect this PR exists to remove.

## #1887 ⊕ #1896 — consolidate, never merge both

Both touch the flat Responses Lite catalog, denied-native-tool routing through
`exec`, and fallback tool shape. Merging both re-splits the contract. Pick one
canonical PR, migrate the other's unique tests into it, close the loser as
superseded.

Matrix the survivor must cover: flat function catalog; code-mode exec; alias;
no bridge; mixed catalog; fetch/read/shell; and — critically — no hardcoded
`exec` when the catalog does not advertise it.

## #1903 — HTTP/1.1 compatibility transport (head 54893ca6e)

Keep HTTP/2 the default and h1 opt-in. Enforce at the transport layer that
credentials cannot egress over remote plain HTTP.

## #1866 — Computer Use / node_repl empty or truncated results

Byte truncation is the wrong repair. The model needs a structured summary it can
act on: focused app/window, URL, current element identity, action error, an
explicit "re-query state" recovery instruction, and a screenshot/blob reference,
with the full payload in bounded separate storage.

## Accept criteria

Train order preserved; exactly one of #1887/#1896 lands; no credential reaches a
remote plain-HTTP endpoint in any test; #1866 either lands structured payloads or
is reported with its real terminal outcome.
## Order decided by simulation, not by reasoning (WP7 P)

I merged the train into a scratch worktree off `origin/dev` rather than predicting what would
conflict. The planned order fails:

```
#1900 CLEAN → #1895 CLEAN → #1887 CONFLICT → #1896 CLEAN → #1903 CONFLICT
```

Two findings, and they point in different directions.

**#1887 conflicts only because #1896 exists.** They are the duplicate pair this plan already
said to consolidate — five shared `native-exec*.ts` files plus `live-transport.ts`. Choosing
**#1896 as canonical and dropping #1887** removes the collision outright:

```
#1900 CLEAN → #1895 CLEAN → #1896 CLEAN
```

That is the consolidation decision made on evidence instead of preference. #1896 wins on
scope: it is the narrower change (`live-transport` + the `native-exec*` family + `parser`),
while #1887 also drags in `tool-definitions.ts` and two docs files that #1900 already touches.

**#1903 is stale independently of the train.** Merged *alone* onto current `origin/dev` it
still conflicts, in `src/types.ts`. So this is not a train-ordering problem and no amount of
resequencing fixes it — the branch needs a rebase by its author. After the train it picks up a
second conflict in `tests/cursor-hardening.test.ts`, which #1900 also edits.

## Revised order

```
#1900 → #1895 → #1896        (then #1887 closed as superseded)
#1903  — rebase required, not merge-ordering
#1866  — issue, structured Computer Use payload; no PR exists
```

## Merge-readiness (checked at head, before any merge)

| PR | State | Gate |
|----|-------|------|
| #1900 | ready | not draft, `REVIEW_REQUIRED`, 0 failing checks |
| #1895 | **draft** + `CHANGES_REQUESTED` | its own review blocker: guidance must be generated from the advertised catalog, not hardcoded |
| #1896 | **draft** | author has not marked it ready |
| #1887 | **draft** | to be closed as superseded, not merged |
| #1903 | not draft, but `CONFLICTING` | needs an author rebase |

So the honest expectation for this work-phase is **#1900 only**, with the rest carrying
reasons. Four of the five are drafts or conflicting; that is the authors' gate, not mine to
clear.
## Corrections from the WP7 audit — two claims withdrawn

The simulation reproduced exactly. My *explanation* of it did not survive.

**1. I misattributed #1887's conflict.** I wrote that it "conflicts only because #1896
exists," naming the five shared `native-exec*` files. But in the sequence I actually ran,
#1896 had not been merged yet when #1887 conflicted. Re-running with isolation:

| Sequence | Result |
|----------|--------|
| `#1887` alone | CLEAN |
| `#1900 → #1887` | CLEAN |
| `#1895 → #1887` | CLEAN |
| `#1896 → #1887` | CLEAN |
| `#1900 → #1895 → #1887` | **CONFLICT** — `tool-definitions.ts`, `cursor-tool-definitions.test.ts` |

So it takes #1900 **and** #1895 together, and the collision is in `tool-definitions.ts` — not
a `native-exec*` file, and not #1896. The duplicate-pair collision I described is real but
is a different, unobserved conflict. I presented "dropping #1887 removes the conflict" as
evidence-driven when the evidence pointed somewhere else.

**2. The consolidation would have dropped a guard this plan calls critical — do NOT close
#1887 as superseded.** They are not duplicates in kind. #1896 is *guidance*: denied native
ops return a text string asking the model to call `exec` itself, so it needs model
compliance. #1887 is *mechanical*: it intercepts the denied frame and synthesizes a real
`exec` tool call, needing none.

The blocker is `codeModeBridgeGuidance`. Verified in both diffs:

- **#1896** hardcodes the literal `` `exec` `` and `mcp_opencodex-responses_*` names whenever
  `codeMode === true` — a boolean, not a catalog read.
- **#1887** derives them: `cursorNativeExecUsesCodeModeBridge(catalog)` checks
  `hasAdvertisedName` and returns `{kind:"none"}` when the catalog does not advertise `exec`.

That is precisely this document's own critical matrix row — *no hardcoded `exec` when the
catalog does not advertise it* — and it is the exact defect **#1895 exists to remove**. Making
#1896 canonical without migration would re-introduce it one PR after deleting it.

Must migrate into #1896 before #1887 can close:

1. `cursorNativeExecUsesCodeModeBridge` catalog detection (the blocker above)
2. the `native-exec-bridge.ts` rewrite engine — arg translation to `cat`/`ls`/`rg`/`curl` with shell quoting
3. `planNativeExecRewrite`'s finalize-vs-cancel ordering, whose documented failure mode (immediate cancel sets `expectedClose`, finalize no-ops, turn 1 never emits `done`) is hard-won
4. the three `cursor-native-exec-policy.test.ts` cases
5. the Windows PowerShell 5.1 guidance from #604 — no `cd /d`, no heredocs, `&&`/`||` are parser errors

**3. Two smaller corrections.** "#1896 wins on scope" is a wash — 11 files each, and #1896
additionally touches shared `src/responses/parser.ts`. Its real merit is that parser fix
(flattening Codex 0.147's reserved `functions` namespace so freeform `custom` children
survive), which #1887 lacks. And #1903 is not a rebase-and-merge item: it is ~32 files and
~1235 lines including a new 340-line `http1-bidi.ts`, GUI settings, nine locales and
`structure/`. Its two gates do hold — h1 is opt-in, and the Bearer is refused before egress —
but the review surface is much larger than "needs a rebase" suggests.

## Revised outcome for this work-phase

Merge **#1900** only. Its three gates were verified in the diff: non-loopback discovery is
HTTPS-only, the Bearer is refused before any plain-HTTP request builder sees it, and a clean
EOF with open tool calls emits a typed error instead of `done`.
