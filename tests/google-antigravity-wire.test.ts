import { describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import { antigravitySessionId } from "../src/adapters/google-antigravity-wire";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(text = "hello world", stream = false): OcxParsedRequest {
  return {
    modelId: "gemini-3-pro",
    stream,
    context: { messages: [{ role: "user", content: text }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

const provider = {
  adapter: "google",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  googleMode: "cloud-code-assist",
  project: "proj-123",
  apiKey: "ya29.token",
} as OcxProviderConfig;

describe("antigravity CCA envelope", () => {
  test("wraps the gemini body in the CCA envelope with project/userAgent/requestType/requestId/sessionId", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    const env = JSON.parse(req.body);
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(env.model).toBe("gemini-3-pro");
    expect(env.userAgent).toBe("antigravity");
    expect(env.requestType).toBe("agent");
    expect(env.project).toBe("proj-123");
    expect(env.requestId).toMatch(/^agent-/);
    expect(env.request.contents).toBeDefined();
    expect(env.request.sessionId).toMatch(/^-/);
    expect(env.request.model).toBeUndefined();
    expect(env.request.safetySettings).toBeUndefined();
    expect(req.headers["Authorization"]).toBe("Bearer ya29.token");
    expect(req.headers["User-Agent"]).toBe("antigravity");
  });

  test("stream uses :streamGenerateContent?alt=sse", async () => {
    const req = await createGoogleAdapter(provider).buildRequest(parsed("x", true));
    expect(req.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("throws when no project id is available", async () => {
    const noProj = { ...provider, project: undefined } as OcxProviderConfig;
    await expect(createGoogleAdapter(noProj).buildRequest(parsed())).rejects.toThrow(/project id/);
  });

  test("sessionId is deterministic for the same first user text", () => {
    expect(antigravitySessionId(parsed("same"))).toBe(antigravitySessionId(parsed("same")));
    expect(antigravitySessionId(parsed("a"))).not.toBe(antigravitySessionId(parsed("b")));
  });
});

function sseResponse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n`).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("antigravity parseStream unwraps response", () => {
  test("reads response.candidates and response.usageMetadata", async () => {
    const adapter = createGoogleAdapter(provider);
    const chunks = [
      { response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } },
      { response: { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } } },
    ];
    const events: AdapterEvent[] = [];
    for await (const ev of adapter.parseStream(sseResponse(chunks))) events.push(ev);
    expect(events.some(e => e.type === "text_delta" && e.text === "hi")).toBe(true);
    const done = events.find(e => e.type === "done");
    expect((done as Extract<AdapterEvent, { type: "done" }>).usage?.inputTokens).toBe(4);
  });
});
