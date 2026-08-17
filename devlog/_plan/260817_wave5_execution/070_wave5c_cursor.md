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
