# 002 — Live modality probe of the OpenCode Zen free models

The search lane could not classify these models: the official docs publish no
modality, and `GET /v1/models` returns only `id`, `object`, `created`,
`owned_by` — no capability field at all. That absence *is* the root cause of
#1043, so it could not also serve as its evidence.

So the classification was measured instead of inferred. Probed 2026-08-05
against `https://opencode.ai/zen/v1/chat/completions`, no credential (the public
desktop tier the `opencode-free` provider already uses), one 1x1 PNG data URL per
request.

## Method

```bash
IMG='{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAA...ErkJggg=="}}'
curl -s https://opencode.ai/zen/v1/chat/completions \
  -H "content-type: application/json" -H "x-opencode-client: desktop" \
  -d "{\"model\":\"$m\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",
       \"content\":[{\"type\":\"text\",\"text\":\"what is in this image\"},$IMG]}]}"
```

A text-only control (`"content":"hi"`) was run first and returned `200` with a
completion, which is what makes a subsequent image failure attributable to the
image part rather than to auth, quota, or the endpoint being down.

Rate limiting is real on this tier: a tight loop returned `Internal server error`
for every model, and the same requests succeeded with a 12-14 second gap. An
early batch run was discarded for exactly this reason — the uniform failure was
the limiter, not the models.

## Result: 8 of 8 classified, no guesses

| model | image request | verdict |
|---|---|---|
| `big-pickle` | `invalid_request_error … Failed to deserialize the JSON body into the target type` | **text-only** |
| `nemotron-3-ultra-free` | `[404] No endpoints found that support image input` | **text-only** |
| `ling-3.0-flash-free` | `[404] No endpoints found that support image input` | **text-only** |
| `north-mini-code-free` | `[404] No endpoints found that support image input` | **text-only** |
| `laguna-s-2.1-free` | `[404] No endpoints found that support image input` | **text-only** |
| `deepseek-v4-flash-free` | `[400] Model only supports text input; received unsupported content type 'image_url'` | **text-only** |
| `mimo-v2.5-free` | `200`, completion returned | **vision-capable** |
| `longcat-2.0-free` | `200`, completion returned | **vision-capable** |

## Two findings that change the patch

**`big-pickle` reproduces the reported error verbatim.** The issue quotes
`Failed to deserialize the JSON body into the target type: messages[65]: unknown
variant 'image_url'`. That is `big-pickle`'s exact failure shape, and it is the
*only* one of the eight that fails this way — the others return a clean 404 or
400. So the reporter was almost certainly on `big-pickle`, and the defect is
confirmed end to end rather than by analogy.

**Two of the eight accept images, and a blanket classification would have broken
them.** `mimo-v2.5-free` and `longcat-2.0-free` both returned completions for an
image request. The search lane's honest `unknown` verdict, plus one community
report that "the free MiMo model refuses images", would have led straight to a
wrong entry: MiMo is exactly the model that *does* work. Listing it in
`noVisionModels` would silently replace a user's image with a caption on a model
that never needed it.

This is why the probe was worth the ten minutes. The narrow fix is now
evidence-backed rather than blocked, and it covers six models instead of the two
the repository already knew about.

## Caveat recorded honestly

This is a point-in-time measurement of a live free tier, taken once per model.
Zen's catalog is discovered live (`liveModels: true` on the sibling
`opencode-free` entry), so the free roster can change under a static registry
list. The patch should therefore classify what is measured today and leave the
list easy to amend, not claim permanence.

`#1024`'s remaining `TR` / `moonshotai/kimi-k3-free` half is untouched by this —
`TR` is not a built-in registry provider and depends on reporter configuration.
