# 100 — The three large units: #1686, #1049, #1798

These are genuinely big and each deserves its own cycle. Documented here so the scope is explicit rather than implied.

## #1686 — bearer admission + guaranteed main substitution

The roadmap's framing (an accidental upstream leak) is **wrong** — see `000_research.md`. The real defect is that the proxy REFUSES the intended flow: `/v1/responses` admission reads only `x-opencodex-api-key` (`src/server/auth-cors.ts:441`) and Direct rejects a recognized proxy bearer before upstream resolution (`src/server/responses/core.ts:970`, `src/server/auth-cors.ts:392`).

Required shape:

1. Make `DataPlaneAdmission` presentation-source-aware (`loopback | dedicated | bearer | x-api-key`) while keeping credential identity. It exists today as `configured | environment | loopback` (`src/server/auth-cors.ts:314`).
2. Accept a bearer fallback for Responses admission, dedicated header keeping precedence, `x-api-key` still rejected there. Update `AUTH_MATRIX` (`:379`).
3. Thread the admission into HTTP handling — it is currently dropped before `handleResponses` (`src/server/index.ts:1214`), while WebSocket already retains it (`src/server/ws-bridge.ts:63`).
4. Add the shared `materializeCodexUpstreamAuth` the roadmap names, built on today's `headersForCodexAuthContext` (`src/codex/auth-context.ts:454`): pool/main-pool always overwrite; `main` + admission bearer requires a live stored main token and overwrites both Authorization and account id, throwing before I/O if unavailable; `main` + dedicated admission + a distinct real ChatGPT bearer keeps today's intentional passthrough.
5. Emit modern `env_key` in injection (`src/codex/inject.ts:210` currently emits only `env_http_headers`).

**Do not relax `validateForwardAdmissionCredential` on its own.** Without guaranteed overwrite that creates precisely the leak the guard prevents today. This is a security-boundary change and needs explicit security review.

## #1049 — legacy Codex home adoption

Legacy homes bypass the write lock entirely: injection calls `applyNativeArtifacts()` directly for `legacy-uncoordinated` (`src/codex/inject.ts:901`) and restore calls `restoreCodexConfigInline()` (`:1504`). `tests/codex-inject-write-lock.test.ts:144` currently PINS that bypass.

The `adoption-pending` design exists only in the archived contract (`devlog/_fin/260804_codex_write_substrate/005_contract.md:709`, crash boundary at `:735`); runtime `transition-state.ts` does not accept that status. Already satisfied: residue detection, invalid-record refusal, unversioned/rowless refusal (`src/codex/transition-state.ts:269`, `:288`).

Missing: adoption itself plus crash-recoverable publication. This is a migration touching every existing install and must not be bundled with ordinary writer migration.

## #1798 — restore must survive an app rewrite

Injection stores original bytes plus an injected hash; when the Codex App rewrites `config.toml`, the hash mismatch makes journal restore refuse (`src/codex/journal.ts:123`). Fallback removal then only recognizes an `openai_base_url` immediately preceded by the OpenCodex marker (`src/codex/injected-marker.ts:53`, `src/codex/inject.ts:1193`), so an app-rewritten unmarked line survives.

Current behavior is exact-byte restore-or-strip. What is needed is a baseline/injected/current three-way semantic merge, so a user edit is preserved while every OpenCodex-owned routing line is removed.

Partially satisfied already: catalog backup lookup falls back from the hash-named backup to the legacy backup for the default path (`src/codex/catalog/parsing.ts:545`).

**Do not ship a marker-only deletion patch.** An unmarked root URL may be genuinely user-owned; deleting it because it looks like ours is data loss.
