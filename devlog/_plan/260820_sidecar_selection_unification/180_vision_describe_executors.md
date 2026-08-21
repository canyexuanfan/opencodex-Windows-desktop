# 180 — Describe executors + runtime dispatch (wp3 implementation cycle)

Depends on: 170.

## src/vision/xai-describe.ts (new)

Mirror xai-executor.ts scaffolding: pinned https://api.x.ai origin,
getValidAccessToken("xai"), redirect "manual", fetchWithResetRetry,
signalWithTimeout(settings.timeoutMs) + cancelBodyOnAbort,
sidecarEnter("vision"), redactSecretString on every error path. Body: 160
wire. Non-stream preferred if probe allows (stream:false) — else reduce SSE
output_text deltas. validateImageUrl reused from describe.ts (data: allowed
mimes + 20MB cap, https passthrough). Reasoning: settings.reasoning passes
through as reasoning.effort only for low|medium|high; xhigh/max clamp to high
(xai ladder). Returns DescribeOutcome, never throws.

## src/vision/gemini-describe.ts (new)

Mirror gemini-executor.ts: registry-pinned base, ANTIGRAVITY_REQUEST_UA,
getValidAccessTokenSnapshot (token + projectId), CCA envelope from 160 with
inlineData part; resolveAntigravityEffortWireModel(settings.model,
settings.reasoning, base) for wire model + thinkingLevel; readBoundedResponseBytes;
data: URLs only (https rejected with explicit error, documented delta);
sidecarEnter("vision"); redactSecretString. Returns DescribeOutcome.

## Runtime dispatch (src/vision/index.ts)

- VisionPlan gains backend arms: { backend: "xai", xaiSidecar: {providerName,
  provider} } and { backend: "gemini", geminiSidecar: {...} } following the
  anthropicSidecar shape.
- planVisionSidecar: after resolving cfg.backend, arms for xai/gemini require
  their descriptor isActive (else fall through to legacy resolution — a
  persisted xai backend with expired auth degrades exactly like anthropic
  without OAuth: sidecar unavailable marker, never a crash).
- resolveVisionBackend: explicit backend honored for all four; DEFAULT
  (unset) order unchanged: anthropic-if-auth else openai. No default drift.
- executeDescription: two new arms calling the new executors.
- descriptionIdentity: backend already part of the cache key; reasoning is
  keyed only for openai — include it for xai too (effort affects output);
  gemini keys thinkingLevel via model+reasoning inputs.
- resolveEffectiveVisionModel: per-backend defaults — xai: grok-4.3,
  gemini: gemini-3.7-flash (both text,image in metadata); existing openai/
  anthropic defaults unchanged.

## Tests (wp3)

- vision-xai.test.ts, vision-gemini.test.ts (new): executor wire shape
  (mocked fetch), error taxonomy, redaction, data-URL validation, effort
  clamp/wire-model mapping.
- vision-sidecar-e2e.test.ts: plan arms for xai/gemini with oauth fixtures;
  degraded no-auth path.

