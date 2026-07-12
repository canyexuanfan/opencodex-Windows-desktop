import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, writeGatewayModelCache } from "../src/claude/gateway-cache";

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

  test("no usable models -> nothing written (never blanks a good cache)", () => {
    const dir = tempDir();
    expect(writeGatewayModelCache("http://127.0.0.1:10100", [{ id: "gpt-only" }], dir)).toBeNull();
  });

  test("claudeConfigDir honors CLAUDE_CONFIG_DIR", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude";
      expect(claudeConfigDir()).toBe("/tmp/custom-claude");
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(claudeConfigDir().endsWith("/.claude")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});
