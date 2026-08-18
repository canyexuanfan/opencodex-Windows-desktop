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
## WP7 outcome

**One merged, four carried — and one plan decision reversed.**

| PR | Outcome | Evidence |
|----|---------|----------|
| #1900 | merged | `2b12521ee`; run `32010651646` `completed/success` — four shards, macOS, gates, npm-global ×3, keyring ×3 |
| #1895 | held | draft + `CHANGES_REQUESTED`; its own review blocker |
| #1896 | held | draft; carries the migration list before it can be canonical |
| #1887 | **kept open** | plan said close as superseded; reversed — it holds the catalog-aware guard |
| #1903 | rebase needed | conflicts in `src/types.ts` against `dev` on its own |
| #1866 | untouched | issue, no PR exists |

**Process correction that stuck.** WP6 faulted me for merging #1902 about eight minutes before
its CI could be judged. For #1900 the fork run was approved, waited to `completed/success` at
`01:12:10Z`, and merged at `01:15:18Z` — three minutes after, verified independently.

`#1866` needs no decision here: it is an issue with no PR, and the structured Computer Use
payload it describes is a design task rather than a merge.
