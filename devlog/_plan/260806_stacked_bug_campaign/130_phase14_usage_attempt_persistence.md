# 130 — Phase 14: usage-log attempt persistence (PR #1093)

Credit: **Takashi Yamashiro**
(`Takashi Yamashiro <email from PR head>`), PR #1093.
Adoption: **adapted** — attempt recording kept, forgeable ingress spans dropped.

## Defect

Ordinary request attempts are not persisted, so the usage log cannot show what
was actually attempted; normalization also collapses explicit empty arrays,
losing the distinction between "no attempts" and "not recorded".

## Why adapted

The attempt-persistence half is useful and correct. The ingress-span half is
not safe as written: the endpoint reads a client-supplied correlation header at
the public admitted surface (`src/server/index.ts:957`), so **any admitted
client can forge a regex-shaped "guard-issued" ingress span**. Persisted
telemetry that an untrusted caller can shape is worse than absent telemetry —
it looks authoritative. That half waits for a trusted producer boundary.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/server/responses/core.ts` | MODIFY | `:1637` — create the ordinary request attempt after final adapter resolution, using the existing attempt owner |
| `src/server/request-log.ts` | MODIFY | Use the existing owner at `:939`; no new writer |
| `src/usage/log.ts` | MODIFY | `:323` — preserve explicit empty arrays through normalization |
| `tests/usage-log*.test.ts`, `tests/request-log*.test.ts` | MODIFY | Attempt row presence after resolution; empty-array preservation |

**Dropped:** ingress-span persistence and the client-header read at
`src/server/index.ts:957`.

## Verification

- `bun test` on the usage-log and request-log suites
- `bun run typecheck`
- `bun run privacy:scan` (must stay green — no account identifiers in the log)

## PR

Stack 13, base = stack 12 head. Credits Takashi Yamashiro and explains the
security reason the ingress-span portion was withheld.
