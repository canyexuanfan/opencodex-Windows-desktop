import { describe, expect, test } from "bun:test";
import { anthropicToolCallId } from "../src/adapters/tool-call-id";

// #1767: Anthropic validates tool_use.id against [a-zA-Z0-9_-]. A history replayed from another
// provider path can carry ids that do not conform, and one of them anywhere in the transcript
// fails the whole request with a 400.
describe("anthropicToolCallId", () => {
  test("leaves a conforming id untouched", () => {
    expect(anthropicToolCallId("call_5sNzuhhhfcuN91ysezpcwXjp")).toBe("call_5sNzuhhhfcuN91ysezpcwXjp");
    expect(anthropicToolCallId("call-9f1c2d3e-4")).toBe("call-9f1c2d3e-4");
    expect(anthropicToolCallId("toolu_01A2b3C4")).toBe("toolu_01A2b3C4");
  });

  test("rewrites the composite id from the report", () => {
    const raw = "call_5sNzuhhhfcuN91ysezpcwXjp\nfc_0c71abbccafaad67016a803ba3007487d2afa509a7ca8c9687";
    const out = anthropicToolCallId(raw)!;

    expect(out).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(out).not.toContain("\n");
    expect(out.startsWith("call_5sNzuhhhfcuN91ysezpcwXjp_fc_")).toBe(true);
  });

  test("is deterministic, so a call and its result still pair up", () => {
    const raw = "call:a/b c";
    expect(anthropicToolCallId(raw)).toBe(anthropicToolCallId(raw));
  });

  test("keeps distinct raw ids distinct after rewriting", () => {
    // Without the hash suffix both of these would collapse to "call_a".
    const a = anthropicToolCallId("call:a");
    const b = anthropicToolCallId("call/a");

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(b).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  test("returns undefined for an empty id so the caller can omit the field", () => {
    expect(anthropicToolCallId("")).toBeUndefined();
    expect(anthropicToolCallId(undefined)).toBeUndefined();
  });
});
