# 190 — Surfaces, live proof, delivery (wp4 cycle)

Depends on: 180.

## GUI

- Split the shared SidecarBackend (dashboard-shared.ts:62): web-search side
  keeps its server-provided backend strings (already emits xai/gemini/exa —
  stale type fixed by the split); vision side gets
  VisionBackend = "openai" | "anthropic" | "xai" | "gemini".
- visionSidecarBackendForModel fallback stays server-provenance-first;
  catalog inference (anthropic-vs-openai guess) only for legacy rows.
- claude-manual-env.ts SidecarOverride backend union widens for vision.
- No new dropdown UI: options arrive from visionModels server list already.

## CLI

- src/cli/agent.ts: usage already names xai|gemini; verify backend values
  pass through PUT unvalidated client-side (server gate authoritative);
  vision --list renders new backends' rows.

## Live proof (acceptance 3-5)

- GET /api/sidecar-settings on live :10100 shows visionModels containing
  xai/gemini rows (auth present on this machine for both — web-search rows
  prove it).
- PUT vision {backend:"xai", model:"grok-4.3"} → 200; PUT model grok-4
  (bare) → 400 provably-blind; restore original settings after proof.
- GUI screenshot of the vision dropdown listing Grok/Gemini rows.

## Delivery

- Small commits per layer (backends table / eligibility+gate / executors /
  GUI+CLI / tests+devlog), full bun run typecheck + bun run test green at
  final head, push directly to dev (user-authorized, no PR).
- devlog docs 160-190 land with the same push train; unit stays in _plan
  until the release train closes it.

