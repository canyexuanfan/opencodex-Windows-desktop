# 002 — Hosted web-search protocol research (규약, verified 2026-08-20)

Luna swarm (5 lanes) + primary-source verification. All findings below were source-opened (official docs) unless flagged lead. Supersedes the doc-only table in 031 with verified wire contracts.

## OpenAI Responses (current openai backend)
- Tool: `{"type":"web_search"}` (legacy: web_search_preview; preview models gpt-4o-*-search-preview shut down 2026-07-23).
- Output item `web_search_call`, id prefix `ws_`; action.type ∈ search|open_page|find_in_page; sources via include: ["web_search_call.action.sources"].
- filters.allowed_domains / blocked_domains ≤ 100 each (web_search only, not preview); external_web_access toggle.
- SSE: response.web_search_call.in_progress|searching|completed (item_id, output_index, sequence_number).
- $10/1k calls (+ content tokens). [developers.openai.com web-search guide; platform pricing]

## Anthropic Messages (current anthropic backend)
- Tool versions: web_search_20250305 (basic, direct-call default, ZDR-eligible), web_search_20260209 (dynamic filtering via code_execution_20260120; allowed_callers defaults to code-exec — direct use requires allowed_callers:["direct"]), web_search_20260318 (response-inclusion control). 20250305 NOT deprecated.
- Blocks: server_tool_use (id prefix srvtoolu_) → web_search_tool_result (tool_use_id pairing); encrypted_content MUST be replayed unchanged in continuations or 400.
- SSE: content_block_start(server_tool_use) → input_json_delta → content_block_stop → content_block_start(web_search_tool_result); usage server_tool_use.web_search_requests in message_delta.
- max_uses cap → web_search_tool_result_error(max_uses_exceeded); org-level enablement required else 400.
- NOT on Bedrock; Vertex basic-only. $10/1k searches, failures unbilled. [platform.claude.com web-search-tool, server-tools, streaming]

## xAI Grok Responses (future backend candidate)
- POST api.x.ai/v1/responses; tools `{"type":"web_search"}` / `{"type":"x_search"}`; output items web_search_call / x_search_call (server-executed, NOT function_call).
- web_search: filters.allowed_domains ≤ 5, allowed/excluded mutually exclusive. x_search: allowed_x_handles ≤ 20 on tool object (NOT nested under filters).
- include: web_search_call.action.sources documented; x_search_call sources selector UNDOCUMENTED → live probe required. Id prefixes undocumented → treat opaque, live probe required (matches #2190).
- Responses SSE event names NOT documented (only SDK chunk.tool_calls) → probe required before relay implementation.
- Live Search: no formal deprecation notice found (issue #2188 text says 2026-01 deprecate — docs do not confirm; treat as legacy either way). $5/1k per tool. [docs.x.ai tools/*, pricing, release-notes]

## Google Gemini (future backend candidate)
- Legacy generateContent: tools [{google_search: {}}] (older models: google_search_retrieval); response candidates[].groundingMetadata {webSearchQueries, searchEntryPoint.renderedContent, groundingChunks[].web{uri,title}, groundingSupports[].segment+groundingChunkIndices}. Chunk indices accumulate across stream.
- Interactions API: tools [{type:"google_search"}]; steps google_search_call (id ex. search_call_19201, arguments.queries[], search_type web_search|image_search|enterprise_web_search, optional signature) → google_search_result (call_id) → model_output with inline URL annotations. SSE: interaction.created, step.start|delta|stop, interaction.completed, done.
- Stateless clients must replay id + encrypted signature manually. Tool-choice: validated mode required with tool-context circulation; auto unsupported.
- Auth x-goog-api-key; standard-key support ends 2026-09. Pricing: Gemini 3.x 5,000 free searches/mo then $14/1k per actual query; ≤2.5 models $35/1k per grounded prompt. [ai.google.dev grounding, interactions-api, pricing]

## Non-LLM vendors (Exa-class lane, #414)
- Exa: POST api.exa.ai/search, x-api-key or Bearer; {query, type, numResults, contents} → {requestId, results[{title,url,id,publishedDate,text/highlights/summary}], costDollars}. SSE only with outputSchema (OpenAI chat-chunk shaped).
- Tavily: POST api.tavily.com/search, Bearer tvly-*; plain JSON, no SSE. $0.008/credit.
- Brave: GET api.search.brave.com/res/v1/web/search, X-Subscription-Token; plain JSON. $5/1k.
- OpenCode upstream now uses MCP JSON-RPC (mcp.exa.ai/mcp, search.parallel.ai/mcp; tools/call name="web_search") — NOT a Responses hosted tool. Zen /zen/go/v1/responses hosted web_search: LEAD ONLY, inconsistent SSE observed, {"type":"remote_tool"} rejected by backend; #1616's probe claim needs fresh re-verification before any Zen backend work.

## Consequences for this unit
1. 031's future-descriptor probe contracts updated by this doc (xAI/Gemini both need live probes for SSE + id shapes; Zen demoted to lead).
2. Anthropic executor (anthropic-executor.ts) currently pins web_search_20250305 — fine (not deprecated, ZDR-eligible, direct default). Upgrading to 20260209 would REQUIRE allowed_callers:["direct"] — record as follow-up, not this unit.
3. encrypted_content replay + srvtoolu_ pairing are existing executor obligations — verify tests cover replay-unchanged before touching anthropic paths in L3.

