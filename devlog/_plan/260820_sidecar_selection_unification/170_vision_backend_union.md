# 170 — Backend union + descriptor table (wp2 implementation cycle)

Depends on: 160. Implements #2188 vision rules for xai/gemini; resolves audit
Blockers A and B.

## Design decision: VISION_BACKENDS descriptor table

Mirror WEB_SEARCH_BACKENDS as a SIBLING table (audit Q2) in a new
`src/vision/backends.ts`:

```ts
interface VisionBackendDescriptor {
  backend: VisionSidecarBackend;            // "openai" | "anthropic" | "xai" | "gemini"
  isActive(auth: SidecarAuthState, config: OcxConfig): boolean;
  candidateMatch(candidate: VisionCandidateModel, auth: SidecarAuthState): boolean;
  baseline?: string;                        // only openai/anthropic carry one
  rank: number;                             // stable option ordering
}
```

- openai: isActive = auth.isCodexAuth-shaped predicate already used by
  enabledVisionBackends (listOpenAiForwardSidecarCandidates > 0); baseline
  gpt-5.6-luna; rank 0.
- anthropic: isActive = anthropicSidecar resolved; candidateMatch =
  provider === auth.anthropicProviderName; baseline claude-haiku-4-5; rank 1.
- xai: isActive = same predicate as WEB_SEARCH_BACKENDS xai (enabled oauth
  "xai" provider + active account !needsReauth); candidateMatch =
  candidate.provider === "xai"; NO baseline; rank 2.
- gemini: isActive = Antigravity OAuth + projectId (same as web-search);
  candidateMatch = provider === "google-antigravity"; NO baseline; rank 3.
- Empty-auth fallback (no side active): ["openai","anthropic"] only —
  xai/gemini are never offered unauthenticated (audit Q1 gap).

## Blocker A resolution — baselines

`BASELINE_VISION_MODELS` stays a record of exactly the two universal sides:
type becomes `Partial<Record<VisionSidecarBackend, string>>` sourced from
descriptor.baseline. visionEligibleModelOptions iterates descriptors (not the
hardcoded 2-tuple), injecting a baseline row only when descriptor.baseline is
set and that side isActive.

## Blocker B resolution — provably-blind gate

`visionDescriberIsProvablyBlind` widens its vendor probe from
{openai, anthropic} to {openai, anthropic, xai, google} via
resolveMetadataProvider. Collision scan (160) proved no bare id is shared
across the four tables, so "any positive text-only verdict wins" stays sound.
Regression test: PUT model=grok-4 (bare, text-only in xai table, absent from
candidates) must 400; PUT model=grok-4.3 with xai auth must 200.

## Files touched (wp2)

- src/vision/backends.ts (new): descriptor table + sidecarVisionBackends()
  helper returning active descriptors.
- src/vision/eligibility.ts: union widens; BASELINE_VISION_MODELS type;
  visionBackendForCandidate delegates to descriptor candidateMatch (keeps
  signature; gains optional auth arg via new overload consumed by options
  path); visionEligibleModelOptions iterates descriptors ranked.
- src/types.ts: OcxVisionSidecarConfig.backend union widens.
- src/server/management/vision-sidecar-options.ts: enabledVisionBackends
  delegates to descriptors; visionDescriberIsProvablyBlind four-family probe.
- src/server/management/config-routes.ts: PUT gate literals :594-596, hint
  fall-through :623, claude-code override :738-740 — all widen to the union.
- tests: sidecar-settings-vision-filter.test.ts, vision-eligibility.test.ts,
  sidecar-settings-vision-controls.test.ts extended; new fixture with xai +
  antigravity oauth accounts (pattern from web-search-backend-union.test.ts).

## Not in wp2

Executors (180) — planVisionSidecar keeps its current arms; a persisted
xai/gemini backend without an executor cannot be SELECTED at runtime yet, so
wp2 lands options+gate first with resolveVisionBackend still collapsing
unknown-to-executor backends to the legacy default order. planVisionSidecar
gains its arms in wp3 in the same push train (dev gets both before release).

