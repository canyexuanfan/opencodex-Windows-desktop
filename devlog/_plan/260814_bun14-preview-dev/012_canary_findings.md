# 012 — What the canary lane found

A running log of behaviour differences between the bundled stable runtime and
the qualification candidate. This is the output the lane exists to produce:
each entry is a difference that would otherwise have surfaced on Bun 1.4
release day, with production traffic attached.

- control: `1.3.14+0d9b296af` (npm bundled)
- candidate: `1.4.0-canary.1+032b8dbf1` (GitHub `canary`)

## F1 — TOML datetime is now supported (real upstream change)

**Bun 1.4 added TOML datetime parsing.** Measured directly:

```text
Bun.TOML.parse('model_catalog_json = 1979-05-27T07:32:00Z')

1.3.14 →  THREW BuildMessage: Expected key but found -
1.4.0  →  type=string  "1979-05-27T07:32:00Z"
```

Fallout: `tests/codex-native-residue.test.ts` asserted that every non-string
TOML type for `model_catalog_json` lands on `surface: "config"`. On 1.3.14 that
holds because the document does not parse at all. On 1.4 the value parses to a
string, `src/codex/native-residue.ts` accepts it (it requires a non-empty
string, and now gets one), resolves it as a path, and the CATALOG surface
reports it absent.

`src/` is correct on both runtimes — only the test's assumption was
version-specific. Fixed in `4e64e96f7` by splitting the datetime case out and
asserting the property that survives both: the classification is
`indeterminate`, blamed on `config` or `catalog`, and coordinator
initialization is refused either way.

**Worth noticing beyond the test:** any config key read through
`Bun.TOML.parse` that a user could write as a bare datetime literal silently
changes type between these runtimes — throw on 1.3.14, string on 1.4. This is
the only such key in the tree today, but it is the shape to watch for.

## F2 — SHASUMS256.txt lags the rolling assets (upstream artifact, not a bug here)

```text
bun-darwin-aarch64.zip  updated 2026-08-14T11:52:50Z
SHASUMS256.txt          updated 2026-08-13T14:30:31Z
published digest        e5fab4d53d07…
actual digest           f153e5eca706…
```

Two independent downloads produced identical bytes and an identical revision,
so the assets are stable per-moment; the manifest is what is stale. Recorded in
`011`: `shasumsMatch` is advisory, `Bun.revision` is the pin.

## F3 — The harness qualified the wrong runtime (our bug)

`scripts/ci/run-bun-test-batches.sh` invoked `bun` from PATH, so the lane
exported `OPENCODEX_BUN_PATH` and then ran the bundled stable binary anyway —
a qualification that never happened, reported as if it had. Fixed in
`bce1fe8f4`.

This one is the argument for running the lane at all rather than reasoning
about the runtime on paper.

## F4 — Our own CI drift, surfaced by the lane (our bug)

The first canary run failed `tests/ci-workflows.test.ts` with 3 failures and a
runtime crash. The same 3 failed identically on 1.3.14: earlier commits on this
branch moved the pinned `setup-bun` SHA into the composite action, added a job,
and added a branch, while the hardening test still described the old shape.
Fixed in `7bab92781`.

Bun 1.4 was innocent. Noted because "the canary run is red" is not by itself
evidence about the canary — the control run is what decides that.

## Not yet observed

Nothing yet on the surfaces the migration actually targets: SSE relay
behaviour, Worker teardown timing, or fetch receive-backpressure. Those need
the memory harness (`040`) and the revision-gated paths (`050`, `080`), which
stay closed until a revision is in `qualifiedRevisions`.
