# 090 — #1524: check capability before falling back

## Verified defect

Fallback reuses the ORIGINAL evaluation instead of re-checking the physical candidate: `policy-fallback.ts` carries forward frozen `eligible`, empty exclusions, the old score, and "not tried" state (`src/server/responses/policy-fallback.ts:26`, `:153`).

The runtime eligibility hook checks only whether an encrypted agent task can be decrypted (`src/server/responses/core.ts:1271`, `:1291`, `:1463`). Combo selection checks configured/enabled provider, prior attempts, caller eligibility and cooldown (`src/combos/resolve.ts:85`, `:97`, `:169`) — nothing about whether the request FITS.

So a 200k-token conversation or an image-bearing request can fall back onto a candidate that cannot accept it.

## What already exists

- Capability evidence resolves context windows and image support from config, registry, catalog or native metadata (`src/routing/capability.ts:153`, `:163`, `:174`).
- The INITIAL evaluator can already reject on supplied context/image requirements (`src/routing/evaluator.ts:187`, `:209`, `:280`).
- Request evidence detects tools and images but leaves request context size UNKNOWN (`src/routing/request-evidence.ts:36`).

The missing pieces are (a) an actual request-size measurement and (b) re-running the existing eligibility check at fallback time.

## Fix

1. Populate request context size in `PolicyRequestEvidence`. The serialized request is already available at the fallback boundary; use a token estimate consistent with what the request log already computes rather than inventing a second estimator.
2. In `policy-fallback.ts`, re-evaluate each candidate against the CURRENT request evidence instead of reusing the frozen verdict. Reuse `src/routing/evaluator.ts`'s existing context/modality rejection rather than writing a parallel check.
3. Unknown capability is NOT a pass. When neither config, registry, catalog nor native metadata can answer, treat the candidate as ineligible for a request that requires the capability, and record the reason — the issue explicitly asks for conservative-unknown handling.
4. Never truncate history or drop images to force a candidate to fit. If nothing is compatible, fail with a typed reason naming the constraint.
5. Preserve quota/cooldown/priority semantics: capability is an additional filter, not a replacement ordering.

## Tests

- A fallback candidate with a smaller context window than the request is skipped, and the next compatible one is used.
- An image-bearing request skips a text-only candidate.
- A candidate with unknown modality support is skipped for an image request but still usable for a text one.
- No compatible candidate produces a typed failure naming the constraint, not a silent truncation.
- Cooldown and prior-attempt exclusion still apply unchanged.
