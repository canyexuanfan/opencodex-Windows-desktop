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
