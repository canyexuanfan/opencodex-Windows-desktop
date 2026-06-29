import { afterEach, describe, expect, test } from "bun:test";
import {
  antigravityUsesReplayCache,
  applyAntigravityReplay,
  clearAntigravityReplay,
  observeAntigravityReplay,
  __resetAntigravityReplayCache,
} from "../src/adapters/google-antigravity-replay";
import { sanitizeAntigravityClaudeSignatures } from "../src/adapters/google-antigravity-wire";

afterEach(() => __resetAntigravityReplayCache());

const SIG = "sig-1234567890abcdef"; // >= 16 chars
const MODEL = "gemini-3-pro";
const SESSION = "-12345";

describe("antigravity reasoning-replay cache", () => {
  test("observe then apply re-injects the thoughtSignature onto the model turn", () => {
    observeAntigravityReplay(MODEL, SESSION, [{ text: "thinking", thoughtSignature: SIG }]);
    const contents = [
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "thinking" }] },
    ];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[1].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("ignores signatures shorter than the minimum length", () => {
    observeAntigravityReplay(MODEL, SESSION, [{ text: "x", thoughtSignature: "short" }]);
    const contents = [{ role: "model", parts: [{ text: "x" }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("does not clobber an existing signature on the outgoing part", () => {
    observeAntigravityReplay(MODEL, SESSION, [{ text: "x", thoughtSignature: SIG }]);
    const contents = [{ role: "model", parts: [{ text: "x", thoughtSignature: "existing-sig-abcdef" }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe("existing-sig-abcdef");
  });

  test("reads the nested extra_content.google.thought_signature alias", () => {
    observeAntigravityReplay(MODEL, SESSION, [{ extra_content: { google: { thought_signature: SIG } } }]);
    const contents = [{ role: "model", parts: [{ text: "x" }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBe(SIG);
  });

  test("clear-on-invalid empties the entry", () => {
    observeAntigravityReplay(MODEL, SESSION, [{ thoughtSignature: SIG }]);
    clearAntigravityReplay(MODEL, SESSION);
    const contents = [{ role: "model", parts: [{ text: "x" }] }];
    applyAntigravityReplay(MODEL, SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });

  test("claude models do not use the replay cache", () => {
    expect(antigravityUsesReplayCache("claude-opus-4.6")).toBe(false);
    expect(antigravityUsesReplayCache("gemini-3-pro")).toBe(true);
    observeAntigravityReplay("claude-opus-4.6", SESSION, [{ thoughtSignature: SIG }]);
    const contents = [{ role: "model", parts: [{ text: "x" }] }];
    applyAntigravityReplay("claude-opus-4.6", SESSION, contents);
    expect((contents[0].parts[0] as { thoughtSignature?: string }).thoughtSignature).toBeUndefined();
  });
});

describe("claude-on-antigravity inline signature sanitization", () => {
  test("drops thinking blocks lacking a valid signature on model turns", () => {
    const contents = [
      { role: "model", parts: [{ thought: true, text: "no sig" }, { text: "answer" }] },
    ];
    sanitizeAntigravityClaudeSignatures(contents);
    expect(contents[0].parts).toHaveLength(1);
    expect((contents[0].parts[0] as { text?: string }).text).toBe("answer");
  });

  test("keeps thinking blocks that carry a signature", () => {
    const contents = [
      { role: "model", parts: [{ thought: true, text: "kept", thoughtSignature: SIG }] },
    ];
    sanitizeAntigravityClaudeSignatures(contents);
    expect(contents[0].parts).toHaveLength(1);
  });

  test("strips signature fields from non-model (user) parts", () => {
    const contents = [
      { role: "user", parts: [{ text: "hi", thoughtSignature: SIG, thought_signature: SIG }] },
    ];
    sanitizeAntigravityClaudeSignatures(contents);
    const part = contents[0].parts[0] as { thoughtSignature?: string; thought_signature?: string };
    expect(part.thoughtSignature).toBeUndefined();
    expect(part.thought_signature).toBeUndefined();
  });
});
