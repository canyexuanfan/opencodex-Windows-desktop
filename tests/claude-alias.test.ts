import { describe, expect, test } from "bun:test";
import { aliasForNative, aliasForRoute, CLAUDE_ALIAS_PREFIX, resolveAlias } from "../src/claude/alias";
import { resolveInboundModel } from "../src/claude/inbound";

describe("claude discovery aliases", () => {
  test("round-trips every realistic provider/model shape", () => {
    const cases: [string, string][] = [
      ["gemini", "gemini-3-pro"],
      ["zai", "glm-5.2"],
      ["opencode-go", "kimi-k2.7-code"],   // provider with single dashes
      ["xai", "grok-4.5-fast"],
      ["cursor", "gpt-5.6-sol"],
      ["lidge-gemma", "gemma-4-31b-heretic"],
      ["p", "model--with--double-dash"],    // model may contain `--`
      ["a", "claude-sonnet-4-5-20250514"],
    ];
    for (const [provider, model] of cases) {
      const alias = aliasForRoute(provider, model);
      expect(alias).not.toBeNull();
      expect(alias!.startsWith("claude")).toBe(true); // picker prefix rule (003 G3)
      expect(resolveAlias(alias!)).toBe(`${provider}/${model}`);
    }
  });

  test("native slugs use the pseudo-provider and resolve to bare ids", () => {
    const alias = aliasForNative("gpt-5.5");
    expect(alias).toBe(`${CLAUDE_ALIAS_PREFIX}native--gpt-5.5`);
    expect(resolveAlias(alias!)).toBe("gpt-5.5");
  });

  test("non-representable shapes are skipped, not mangled", () => {
    expect(aliasForRoute("has--dashes", "m")).toBeNull();
    expect(aliasForRoute("has/slash", "m")).toBeNull();
    expect(aliasForRoute("native", "m")).toBeNull(); // reserved pseudo-provider
    expect(aliasForRoute("p", "openrouter/meta-llama")).toBeNull(); // slash in model
    expect(aliasForRoute("", "m")).toBeNull();
    expect(aliasForRoute("p", "")).toBeNull();
    expect(aliasForNative("a--b")).toBeNull();
  });

  test("resolveAlias rejects non-aliases and malformed ids", () => {
    expect(resolveAlias("claude-sonnet-4-5")).toBeNull();
    expect(resolveAlias("gpt-5.5")).toBeNull();
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}noseparator`)).toBeNull();
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}p--`)).toBeNull();
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}--m`)).toBeNull();
  });

  test("no collisions across a registry-shaped corpus", () => {
    const corpus: [string, string][] = [];
    for (const p of ["a", "b", "a-b", "ab"]) {
      for (const m of ["x", "y-z", "y--z", "x.1"]) corpus.push([p, m]);
    }
    const aliases = corpus.map(([p, m]) => aliasForRoute(p, m)).filter((a): a is string => a !== null);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (let i = 0; i < aliases.length; i++) {
      expect(resolveAlias(aliases[i])).toBe(`${corpus[i][0]}/${corpus[i][1]}`);
    }
  });

  test("inbound resolution prefers alias over modelMap, before date-strip", () => {
    const cc = { modelMap: { [`${CLAUDE_ALIAS_PREFIX}gemini--gemini-3-pro`]: "should-not-win" } };
    expect(resolveInboundModel(`${CLAUDE_ALIAS_PREFIX}gemini--gemini-3-pro`, cc)).toBe("gemini/gemini-3-pro");
  });
});
