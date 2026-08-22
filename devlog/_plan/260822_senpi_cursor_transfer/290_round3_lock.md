# 290 — Round-3 lock

Probes executed on macmini (live account, redacted transcripts in 210-250;
raw dumps deleted from probe host after lock per 200 hygiene).

## Implementation order (this loop)

1. **230 — #2305 text-marker normalization** (IMPLEMENT; clear defect, open
   issue, code-grounded fix point).
2. **260 — bare-RE size prior** (IMPLEMENT; live-evidenced false-overflow
   class; a refinement senpi's own T01 lacks).

## Closed by probe (no code)

- 210 maxMode: BLOCKED (plan tier) — flag accepted but -fast entitlement
  absent; NEEDS_HUMAN to provision a -fast-capable account for re-probe.
- 220 rotation: NOT REPRODUCED at 4x101K; T02 stays deferred.
- 240 client version: NOOP — three version strings byte-identical catalogs.
- 250 billed usage: NOOP — no cacheRead pathology on this plan.

## Updated senpi verdict

With 230+260 landed, remaining senpi-ahead rows shrink to: rotation
persistence (unreproducible here), maxMode (plan-gated for both projects
without entitlement), agent-loop-level stop/exec ownership (out of adapter
scope; #2305's actual defect is ours to fix and is fixed). OpenCodex keeps
its unique-side advantages (interactionQuery, HTTP/1 fallback, SelectedImage
vision, bounded memory, T04 watchdog with senpi-matching thresholds, typed
exec errors, EOF fail-closed tests). Verdict: at parity or ahead on every
row that is provable on this plan tier; the two rows senpi still leads
require entitlement or a reproduction neither project can show today.

## Post-landing status (locked after implementation)

- 230 landed: PR #2341 (896cb5720), closes #2305 — 4 regression tests.
- 260 landed: PR #2342 (8f3ac5fe9) — size prior with 5 regression tests;
  strictly narrowing (unknown context keeps the #2320 overflow mapping).
- Final gate: Cross-platform CI on the resulting dev head (see PR checks);
  the verdict above stands as written — no remaining provable senpi-ahead
  row on this plan tier.
