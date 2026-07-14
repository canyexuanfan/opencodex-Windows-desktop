# Shadow Call Intercept

## What are shadow calls?

Codex Desktop App makes background API calls using `gpt-5.4-mini` for internal helper tasks:

- **Thread title generation** — auto-generates 3-8 word titles after your first prompt
- **Commit message generation** — generates git commit messages
- **Skill orchestration** — internal orchestration turns

These calls happen independently of your selected main model and use `reasoningEffort: low`.

## The problem

- Non-OpenAI providers (Bedrock, Azure, etc.) may not support bare `gpt-5.4-mini`, causing 404 errors
- Users have no control over which model handles these helper tasks
- Shadow calls consume API quota without user awareness

Related GitHub issues: [#26288](https://github.com/openai/codex/issues/26288), [#28741](https://github.com/openai/codex/issues/28741), [#28821](https://github.com/openai/codex/issues/28821), [#24208](https://github.com/openai/codex/issues/24208)

## Configuration

### Via Dashboard UI

1. Open the opencodex dashboard
2. Find the "Shadow Call Intercept" panel
3. Toggle the switch to enable
4. Enter a replacement model (e.g., `gpt-5.5`)

### Via config.json

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5"
  }
}
```

### Behavior

- When enabled, ALL requests with model IDs starting with `gpt-5.4-mini` are rewritten to the configured model
- Reasoning effort is forced to `low` (matching the original behavior)
- The original model ID is logged as `shadowCallRewrittenFrom` in request logs
- When disabled (default), no interception occurs

### Warning

Enabling this redirects ALL gpt-5.4-mini requests. If you intentionally use gpt-5.4-mini for other tasks, those will also be redirected.
