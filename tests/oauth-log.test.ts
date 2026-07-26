import { describe, expect, test } from "bun:test";
import { logOAuthEvent } from "../src/oauth/log";

describe("logOAuthEvent", () => {
  test("emits redacted account and never prints a token-looking field value", () => {
    const lines: string[] = [];
    const original = console.info;
    console.info = (msg?: unknown) => { lines.push(String(msg)); };
    try {
      logOAuthEvent("OAuth refresh started", {
        provider: "kiro",
        accountId: "acct_abcdefghijklmnopqrstuvwxyz",
        until: "2026-07-23T14:30:00.000Z",
      });
    } finally {
      console.info = original;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[opencodex]");
    expect(lines[0]).toContain("provider=kiro");
    expect(lines[0]).toContain("account=account-…wxyz");
    expect(lines[0]).not.toContain("acct_abcdefghijklmnopqrstuvwxyz");
  });
});
