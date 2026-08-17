# 040 — Inventory every credential writer's Windows ACL coverage (F5)

**Depends on:** nothing. Can run parallel to 010-030; sequence it after so its
findings land against a settled tree.

## Change

This phase produces a document, not a patch.

Enumerate every path that writes a credential, token, OAuth refresh token, or
session secret. Starting points: `src/config.ts` (chmod sites at 221, 316, 450,
1713, 2683; dir sites 1704, 2632), `src/oauth/store.ts`, `src/service.ts:189`
and `:386`, `src/lab/artifacts/secure-fs.ts`,
`src/adapters/google-antigravity-replay.ts:251`.

For each, record: the file written, whether `hardenSecretPath` (or the async
twin) runs on **that specific write**, and whether the `chmod` is the only
protection. `chmodSync` is a no-op on Windows; `src/service.ts:1983` says so
outright — "required Windows ACL is authoritative". A writer with only the
`chmod` has no protection on Windows at all.

Output: a table in this unit listing writer, ACL status, and verdict.

## If the inventory finds a live exposure

Stop. Per AGENTS.md, pre-disclosure security material does not go in `devlog/`
— it goes to `.tmp/` or a `mktemp -d` path, and only the shipped fix plus its
regression test come back here. This phase's deliverable in that case is the
table with the exposed rows redacted and a pointer to the scratch location.

## Verify

Inventory correctness is verified by reading, not by a command. Each row cites
the writing line and the hardening line (or its absence).

## Risk

None to the runtime. The risk is doing it carelessly and recording a false
negative — a writer that looks covered because `hardenSecretPath` appears
somewhere in the file rather than on that path.
