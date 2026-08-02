import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, refreshGatewayModelCacheFromProxy, writeGatewayModelCache } from "../src/claude/gateway-cache";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ocx-gwcache-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Claude Code gateway-model cache pre-write (devlog 260712 030)", () => {
  test("writes the CLI's exact schema and mirrors the usable-id filter", () => {
    const dir = tempDir();
    const path = writeGatewayModelCache("http://127.0.0.1:10100", [
      { id: "claude-opus-4-8-ncb", display_name: "gpt-5.6-sol (native)" },
      { id: "claude-opus-4-8-ncb[1m]", display_name: "gpt-5.6-sol (native) · 372k" },
      { id: "anthropic-something", display_name: "x" },
      { id: "gpt-5.6-sol" }, // fails /^(claude|anthropic)/i — dropped like the CLI would
    ], dir);
    expect(path).toBe(join(dir, "cache", "gateway-models.json"));
    const body = JSON.parse(readFileSync(path!, "utf8"));
    expect(body.baseUrl).toBe("http://127.0.0.1:10100");
    expect(typeof body.fetchedAt).toBe("number");
    expect(body.models).toEqual([
      { id: "claude-opus-4-8-ncb", display_name: "gpt-5.6-sol (native)" },
      { id: "claude-opus-4-8-ncb[1m]", display_name: "gpt-5.6-sol (native) · 372k" },
      { id: "anthropic-something", display_name: "x" },
    ]);
  });

  test("no usable models -> authoritative empty written (stale cache cleared)", () => {
    const dir = tempDir();
    const path = writeGatewayModelCache("http://127.0.0.1:10100", [{ id: "gpt-only" }], dir);
    expect(path).not.toBeNull();
    const cached = JSON.parse(readFileSync(path!, "utf8"));
    expect(cached.models).toEqual([]);
  });

  test("claudeConfigDir honors CLAUDE_CONFIG_DIR", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude";
      expect(claudeConfigDir()).toBe("/tmp/custom-claude");
      delete process.env.CLAUDE_CONFIG_DIR;
      // Platform-correct separator (Windows CI joins with backslash).
      const { homedir } = require("node:os") as typeof import("node:os");
      expect(claudeConfigDir()).toBe(join(homedir(), ".claude"));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  test("proxy refresh pins the readable id family with ?ids=cli (audit 051 #5)", async () => {
    const dir = tempDir();
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ data: [{ id: "claude-ocx-native--gpt-5.6-sol", display_name: "gpt-5.6-sol (native)" }] }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const path = await refreshGatewayModelCacheFromProxy(10100, 1000, dir);
      expect(requestedUrl).toContain("ids=cli");
      const body = JSON.parse(readFileSync(path!, "utf8"));
      expect(body.models[0].id).toBe("claude-ocx-native--gpt-5.6-sol");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
