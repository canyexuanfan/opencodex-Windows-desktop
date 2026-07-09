/**
 * v2 / ultra catalog tests: ultra is always advertised regardless of v2 toggle.
 * The v2 toggle controls the multi-agent surface only, not ultra visibility.
 * config.toml reader + max_concurrent_threads_per_session writer fixtures.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildCatalogEntries, mergeCatalogEntriesForSync, nativeEffortClamp } from "../src/codex/catalog";
import { getMaxConcurrentThreads, hasAgentsMaxThreads, isMultiAgentV2Enabled, setMaxConcurrentThreads } from "../src/codex/features";
import { v2StatusLine } from "../src/cli/v2";

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    supported_reasoning_levels: [
      { effort: "low", description: "l" }, { effort: "medium", description: "m" },
      { effort: "high", description: "h" }, { effort: "xhigh", description: "x" },
    ],
    default_reasoning_level: "medium",
  };
}

function efforts(entry: { supported_reasoning_levels?: unknown }): string[] {
  return (entry.supported_reasoning_levels as Array<{ effort: string }> ?? []).map(l => l.effort);
}

function fixtureConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-v2-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

describe("catalog ultra (always-on)", () => {
  const routed = [{ id: "glm-5.2", provider: "opencode-go", reasoningEfforts: ["low", "medium", "high", "xhigh"] }];

  test("routed + old natives always advertise mock max AND ultra", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.5"], routed as never, [], false);
    const native = entries.find(e => e.slug === "gpt-5.5")!;
    const glm = entries.find(e => e.slug === "opencode-go/glm-5.2")!;
    expect(efforts(native)).toContain("ultra");
    expect(efforts(native)).toContain("max");
    expect(efforts(glm)).toContain("ultra");
    expect(efforts(glm)).toContain("max"); // mock max: adapters/wire clamp keep it honest
  });

  test("gpt-5.6-sol keeps native ultra + max; luna has max but no native ultra (upstream ladder)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna"], [], [], false);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = entries.find(e => e.slug === "gpt-5.6-luna")!;
    expect(efforts(sol)).toContain("max");
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(luna)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("sync preserves genuine native entries with ultra intact", () => {
    const diskSol = {
      ...template(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      supported_reasoning_levels: [
        { effort: "high", description: "h" }, { effort: "max", description: "m" }, { effort: "ultra", description: "u" },
      ],
      default_reasoning_level: "ultra",
    };
    const merged = mergeCatalogEntriesForSync([diskSol as never], [], new Map(), [], false);
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(sol)).toContain("max");
    expect(sol.default_reasoning_level).toBe("ultra"); // preserved as-is
  });
});

describe("features.ts config reader", () => {
  test("table form: [features.multi_agent_v2] enabled = true", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1000\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\nenabled = false\n"))).toBe(false);
  });

  test("boolean form under [features]", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent = true\nmulti_agent_v2 = true\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent_v2 = false\n"))).toBe(false);
    // sibling key must not leak (multi_agent vs multi_agent_v2)
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent = true\n"))).toBe(false);
  });

  test("inline table form + absent file/key -> false", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, tool_namespace = \"agents\" }\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("model = \"gpt-5.5\"\n"))).toBe(false);
    expect(isMultiAgentV2Enabled("/nonexistent/config.toml")).toBe(false);
  });

  test("table detection stops at the next header (no bleed into later tables)", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\n[notice]\nenabled = true\n"))).toBe(false);
  });

  test("hasAgentsMaxThreads detects the boot-conflict key", () => {
    expect(hasAgentsMaxThreads(fixtureConfig("[agents]\nmax_threads = 1000\n"))).toBe(true);
    expect(hasAgentsMaxThreads(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(false);
  });
});

describe("max_concurrent_threads_per_session reader/writer", () => {
  const TABLE = "# keep me\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1000 # tuned\n\n[notice]\nhide = true\n";

  test("reader: present, absent key, absent table", () => {
    expect(getMaxConcurrentThreads(fixtureConfig(TABLE))).toBe(1000);
    expect(getMaxConcurrentThreads(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(null);
    expect(getMaxConcurrentThreads(fixtureConfig("[features]\nmulti_agent_v2 = true\n"))).toBe(null);
  });

  test("writer replaces in place, preserving comments and neighbors", () => {
    const path = fixtureConfig(TABLE);
    const result = setMaxConcurrentThreads(64, path);
    expect(result).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("max_concurrent_threads_per_session = 64 # tuned");
    expect(out).toContain("# keep me");
    expect(out).toContain("[notice]\nhide = true");
    expect(getMaxConcurrentThreads(path)).toBe(64);
  });

  test("writer is idempotent: equal value -> no write, changed:false", () => {
    const path = fixtureConfig(TABLE);
    expect(setMaxConcurrentThreads(1000, path)).toEqual({ ok: true, changed: false });
    expect(readFileSync(path, "utf8")).toBe(TABLE); // byte-identical, no touch
  });

  test("writer inserts under the header when the key is absent", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n\n[notice]\n");
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out.indexOf("max_concurrent_threads_per_session = 32")).toBeGreaterThan(out.indexOf("[features.multi_agent_v2]"));
    expect(out.indexOf("max_concurrent_threads_per_session = 32")).toBeLessThan(out.indexOf("[notice]"));
  });

  test("writer refuses when table is missing or value invalid", () => {
    const noTable = setMaxConcurrentThreads(8, fixtureConfig("[features]\nmulti_agent_v2 = true\n"));
    expect(noTable.ok).toBe(false);
    expect(setMaxConcurrentThreads(0, fixtureConfig(TABLE)).ok).toBe(false);
    expect(setMaxConcurrentThreads(2.5, fixtureConfig(TABLE)).ok).toBe(false);
  });

  test("writer preserves CRLF files", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 4\r\n");
    expect(setMaxConcurrentThreads(8, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("max_concurrent_threads_per_session = 8\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });
});

describe("cli surface", () => {
  test("status lines describe the multi-agent surface", () => {
    expect(v2StatusLine(true)).toContain("ON");
    expect(v2StatusLine(false)).toContain("OFF");
  });
});

describe("mock-max wire clamp (nativeEffortClamp)", () => {
  test("gpt-5.5 max/ultra clamp to its real top rung (xhigh)", () => {
    expect(nativeEffortClamp("gpt-5.5", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.5", "ultra")).toBe("xhigh");
  });

  test("real-max natives are untouched", () => {
    expect(nativeEffortClamp("gpt-5.6-sol", "max")).toBe(null);
    expect(nativeEffortClamp("gpt-5.6-luna", "max")).toBe(null);
  });

  test("ordinary efforts and routed slugs pass through; unknown BARE natives clamp conservatively", () => {
    expect(nativeEffortClamp("gpt-5.5", "high")).toBe(null);
    expect(nativeEffortClamp("gpt-5.5", undefined)).toBe(null);
    expect(nativeEffortClamp("opencode-go/glm-5.2", "max")).toBe(null);
    // off-snapshot bare native = old low..xhigh ladder -> clamp; future 5.6 variants stay free
    expect(nativeEffortClamp("gpt-totally-unknown", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.6-future", "max")).toBe(null);
  });
});
