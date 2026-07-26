# 031 — sweep receipt against the REAL config

Run on a COPY of this machine's `~/.grok/config.toml` (`/tmp/grok-sweep-probe/.grok/`),
never the live file. Original preserved at `/tmp/grok-config-before-511.toml`.

## Before

```
model tables:                 69
tables WITHOUT context_window: 40
default:                      "ocx-gpt-5-6-terra"   (an orphan, no context_window)
```

## After one sync

```
result:                       { ok: true, changed: true }
model tables:                  6   (one per catalog model)
tables WITH context_window:    6   (all of them)
model tables above the fence:  0
default:                      "ocx-gpt-5-6-terra"  -> still defined, now WITH context_window = 372000
```

## Counting caveat worth recording

A first pass reported "23 orphans survived". That was a MEASUREMENT error, not a code
defect: `rg -c '^\[model\.'` also counts `[model.<alias>.extra_headers]` sub-tables,
which the writer emits for every entry. Counting real model tables needs
`'^\[model\.[^.]+\]$'`. Recorded because the wrong pattern makes a correct sweep look
broken, and the same trap is waiting for whoever verifies this next.

## Idempotence (F7)

A second sync over the swept file:

```
2nd run changed: false | bytes identical: true
```

## User content preserved (F1)

`[cli]`, `[ui]` (including `fork_secondary_model = "grok-build"`, a genuine user value),
and `[marketplace]` with its sources are all intact after the sweep.

## What this does NOT yet prove

That Grok's TUI reads the corrected file. That requires the user to restart via
`ocx service` and a visual check — `030` step 2, criterion `c-live`.
