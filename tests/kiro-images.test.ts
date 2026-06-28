import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-images-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_PROFILE_ARN;
});
afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  rmSync(tmp, { recursive: true, force: true });
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;

function parsedWith(messages: unknown[]): OcxParsedRequest {
  return { modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages } } as unknown as OcxParsedRequest;
}

function currentUim(body: string): Record<string, unknown> {
  return JSON.parse(body).conversationState.currentMessage.userInputMessage as Record<string, unknown>;
}

describe("kiro adapter — native images", () => {
  test("data URL image attaches to userInputMessage.images", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", imageUrl: "data:image/png;base64,AAAA" },
      ],
    }];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    const uim = currentUim(body);
    expect(uim.images).toEqual([{ format: "png", source: { bytes: "AAAA" } }]);
    // text still extracted, image NOT inlined as text
    expect(uim.content).toContain("what is this");
    expect(String(uim.content)).not.toContain("AAAA");
  });

  test("jpeg data URL prefix stripped, format derived", () => {
    const messages = [{
      role: "user",
      content: [{ type: "image", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" }],
    }];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    expect(currentUim(body).images).toEqual([{ format: "jpeg", source: { bytes: "/9j/4AAQ" } }]);
  });

  test("remote https image is skipped (no images field, no throw)", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "see this" },
        { type: "image", imageUrl: "https://example.com/cat.png" },
      ],
    }];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    expect(currentUim(body).images).toBeUndefined();
  });

  test("text-only message has no images field (back-compat)", () => {
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(currentUim(body).images).toBeUndefined();
  });

  test("multiple images preserved in order", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "image", imageUrl: "data:image/png;base64,AAA" },
        { type: "image", imageUrl: "data:image/webp;base64,BBB" },
      ],
    }];
    const { body } = createKiroAdapter(provider).buildRequest(parsedWith(messages));
    expect(currentUim(body).images).toEqual([
      { format: "png", source: { bytes: "AAA" } },
      { format: "webp", source: { bytes: "BBB" } },
    ]);
  });
});
