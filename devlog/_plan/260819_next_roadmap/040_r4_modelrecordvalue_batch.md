# 040 — R4: the `modelRecordValue` family, reviewed as one batch

Work-phase: wp4. Scope: **review only. No merges.**

## Why one batch and not four reviews

`#2077`, `#2085`, `#2086`, `#2100` are the same one-line idea applied at four
call sites. Reviewing them separately spends four independent judgments on a
contract that only has to be decided once.

## The shared contract

Per-model override maps (`modelContextWindows`, `modelInputModalities`,
`modelReasoningEfforts`, `modelMaxInputTokens`, `modelMaxOutputTokens`) are
read by the runtime through `modelRecordValue`, which resolves in three steps:

1. own properties only,
2. then the pre-colon family (`gpt-oss` covers `gpt-oss:120b`),
3. then a case-folded key.

A bare `map?.[modelId]` disagrees on all three. The contract to affirm once:
**any code that reports, gates, or describes what the runtime will do with a
per-model override must read it the way the runtime reads it.** A reader that
resolves differently is not conservative — it is wrong in a direction nobody
can predict.

## Why the failure mode is worse than "missing an entry"

In `#2085` and `#2100` the bare lookup does not degrade to unknown; it **falls
through to the provider-wide value**. That is a definite wrong answer rather
than an absent one. `#2085`'s case: `modelContextWindows: {"gpt-oss": 131072}`
with a request for `gpt-oss:120b` resolved nothing, fell back to
`contextWindow: 8000`, and the admission gate refused turns the model can
plainly hold.

`#2077` carries a second, sharper defect worth calling out separately: the bare
index **walks the prototype chain**. A routed model id of `constructor` or
`toString` returns an `Object.prototype` function, which makes
`buildBehaviorFingerprintV1` throw "unsupported value type function". That
throw is swallowed by `resolvePassiveRouteSubjectId`, so the subject is
silently dropped — inside a linker whose contract says implementations do not
throw. `openai-responses.ts` already guards `modelPreferHostedTools` for
exactly this reason.

## Per-PR frame

| PR | Site | Consequence of the bare read |
|---|---|---|
| #2077 | Lab report per-model overrides | prototype-chain function → fingerprint throw → subject silently dropped |
| #2085 | admission input ceiling | falls back to provider-wide window; refuses holdable turns |
| #2086 | `ocx models` CLI | reports capabilities the proxy will not honour |
| #2100 | routing capability evidence | evidence disagrees with the resolver it describes |

`#2086` additionally orders `noVisionModels` **before** `modelInputModalities`,
matching `isModelTextOnly`, which returns true on the noVision match before it
ever reads the modality map. Getting that order wrong would make the CLI
advertise image support that the proxy then rejects — worth confirming the
ordering claim against `src/vision.ts` rather than taking the comment's word.

`#2086` is draft; the other three are ready.

## Exit criteria

- `c-mrv`: one shared contract verdict plus four per-PR verdicts, each from a
  read of the actual diff.
- No merges.
