# 60 — Phase 6: Config URL and header validation

Purpose: reduce SSRF and credential forwarding risk from provider configuration
while preserving legitimate local providers such as Ollama, LM Studio, and vLLM.

Planned surfaces:

- `src/config.ts`
- `src/server.ts` provider create/update validation path
- `src/oauth/key-providers.ts` only if provider validation is centralized there.
- Existing provider/config/server tests.

Checks:

- Reject unsupported protocols for provider base URLs.
- Keep local/private provider URLs allowed only where the product intentionally
  supports local model servers.
- Prevent user-defined sensitive headers from being reflected through management
  APIs or logs.

Verification:

- Focused config/provider API tests.
- Typecheck.
