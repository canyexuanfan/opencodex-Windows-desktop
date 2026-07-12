import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeAgentDefs, injectClaudeAgentDefs, syncClaudeAgentDefs } from "../src/claude/agents-inject";
import type { OcxConfig } from "../src/types";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ocx-agents-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return { port: 10100, defaultProvider: "mock", providers: {}, ...extra } as OcxConfig;
}

describe("buildClaudeAgentDefs (devlog 070 + audit 071)", () => {
  test("roster + always-inherit self; [1m] marking via auto-context; name collision suffix", () => {
    const windows = { "claude-ocx-native--gpt-5.6-sol": 372_000, "claude-ocx-cursor--gpt-5.6-sol": 1_000_000 };
    const defs = buildClaudeAgentDefs(cfg({
      subagentModels: ["gpt-5.6-sol", "cursor/gpt-5.6-sol"],
      claudeCode: {},
    }), windows);
    const byName = Object.fromEntries(defs.map(d => [d.name, d]));
    expect(byName["ocx-gpt-5-6-sol"]!.model).toBe("claude-ocx-native--gpt-5.6-sol[1m]"); // 372k >= 350k default
    expect(byName["ocx-gpt-5-6-sol-2"]!.model).toBe("claude-ocx-cursor--gpt-5.6-sol[1m]"); // collision suffix
    // Self is ALWAYS emitted with inherit (audit 071 #1) — no identity guessing.
    expect(byName["ocx-self"]!.model).toBe("inherit");
    expect(defs).toHaveLength(3);
    // Dispatcher directive (live repro: model:"fable" override broke inherit).
    for (const d of defs) expect(d.description).toContain("WITHOUT the `model` argument");
  });

  test("unset roster seeds the defaults; explicit [] is respected (audit 071 #6)", () => {
    const seeded = buildClaudeAgentDefs(cfg(), {});
    expect(seeded.length).toBe(6); // 5 defaults + self
    const explicit = buildClaudeAgentDefs(cfg({ subagentModels: [] }), {});
    expect(explicit.map(d => d.name)).toEqual(["ocx-self"]);
  });

  test("rendered frontmatter quotes every scalar and parses back", () => {
    const [def] = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {});
    const dir = tempDir();
    syncClaudeAgentDefs([def!], dir);
    const body = readFileSync(join(dir, "agents", def!.file), "utf8");
    const fm = body.split("---")[1]!;
    const fields: Record<string, string> = {};
    for (const line of fm.trim().split("\n")) {
      const idx = line.indexOf(": ");
      fields[line.slice(0, idx)] = JSON.parse(line.slice(idx + 2));
    }
    expect(fields.name).toBe(def!.name);
    expect(fields.model).toBe(def!.model);
    expect(typeof fields.description).toBe("string");
    expect(body).toContain("generated-by: opencodex");
  });
});

describe("syncClaudeAgentDefs ownership contract (audit 071 #2/#3)", () => {
  test("writes, overwrites, and prunes ONLY marker-verified ocx files", () => {
    const dir = tempDir();
    const defs = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {});
    expect(syncClaudeAgentDefs(defs, dir)!.length).toBe(2);
    const agentsDir = join(dir, "agents");
    // User-authored file with our prefix but no marker: untouched by prune AND by write.
    writeFileSync(join(agentsDir, "ocx-custom.md"), "---\nname: ocx-custom\n---\nuser file");
    writeFileSync(join(agentsDir, "ocx-gpt-5-6-sol.md"), "user replaced this — no marker");
    const second = syncClaudeAgentDefs(buildClaudeAgentDefs(cfg({ subagentModels: [] }), {}), dir)!;
    expect(second).toEqual(["ocx-self.md"]);
    const remaining = readdirSync(agentsDir).sort();
    // ocx-self rewritten; unowned ocx-custom + user-replaced sol file both preserved.
    expect(remaining).toEqual(["ocx-custom.md", "ocx-gpt-5-6-sol.md", "ocx-self.md"]);
    expect(readFileSync(join(agentsDir, "ocx-gpt-5-6-sol.md"), "utf8")).toBe("user replaced this — no marker");
  });

  test("symlinks are never followed or pruned", () => {
    const dir = tempDir();
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const victim = join(dir, "victim.md");
    writeFileSync(victim, "precious");
    symlinkSync(victim, join(agentsDir, "ocx-linked.md"));
    syncClaudeAgentDefs([], dir); // prune pass
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readdirSync(agentsDir)).toContain("ocx-linked.md");
  });

  test("injectClaudeAgentDefs prunes owned files when disabled (audit 071 #3)", () => {
    const dir = tempDir();
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(readdirSync(join(dir, "agents")).length).toBe(2);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { injectAgents: false } }), {}, dir);
    expect(readdirSync(join(dir, "agents"))).toEqual([]);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { enabled: false } }), {}, dir);
    expect(readdirSync(join(dir, "agents"))).toEqual([]);
  });
});
