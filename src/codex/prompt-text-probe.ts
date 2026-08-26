/**
 * Reading the prompt text Codex actually assembles.
 *
 * The read-only dialog used to say Codex "does not expose" a layer's text. That
 * was wrong: Codex is open source and ships `codex debug prompt-input`, which
 * renders the model-visible input list as JSON. Reading it is the difference
 * between describing a layer and showing it.
 *
 * What this does NOT cover, stated rather than implied:
 *
 * - `base-instructions` is absent. `prompt_debug.rs` returns `prompt.input` and
 *   discards `base_instructions`, so the base prompt never appears here.
 * - World-state sections are DIFF-rendered (`add_section` registers state, it does
 *   not emit text). A section that renders nothing on a first turn is missing
 *   from this output even though its layer exists.
 * - The output reflects the invoking directory and the current config, not a
 *   universal prompt.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Section id in the DTO -> the tag `world_state` renders it under. */
const LAYER_SECTION_TAGS: Record<string, string> = {
  skills: "skills_instructions",
  apps: "apps_instructions",
  plugins: "plugins_instructions",
  environment: "environment_context",
  permissions: "permissions",
  collaboration: "collaboration_mode",
  "agents-md": "__agents_md",
  // Synthetic key: the project doc has no tag of its own (see extractSections).
  personality: "personality",
  realtime: "realtime",
};

export interface LayerText {
  /** Rendered text, when this layer produced a section on the probed turn. */
  text: string | null;
  /** Why the text is absent, when it is. */
  reason: "ok" | "not-rendered" | "not-exposed" | "unavailable";
  bytes: number;
}

export interface PromptTextProbe {
  ok: boolean;
  /** The directory the probe ran in; sections depend on it. */
  cwd: string;
  layers: Record<string, LayerText>;
  detail?: string;
}

function resolveCodexBinary(): string | null {
  const candidates = [
    join(homedir(), ".codex/packages/standalone/current/bin/codex"),
    join(homedir(), ".local/bin/codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];
  return candidates.find(path => existsSync(path)) ?? null;
}

function runProbe(binary: string, cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    // A probe must never hang the management API: it is bounded, killed on
    // timeout, and any failure degrades to "unavailable" rather than an error page.
    const child = spawn(binary, ["debug", "prompt-input"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
    child.stdout?.on("data", chunk => { out += String(chunk); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/** Pull every `<tag>...</tag>` section out of the rendered developer messages. */
function extractSections(raw: string): Map<string, string> {
  const sections = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sections;
  }
  if (!Array.isArray(parsed)) return sections;
  for (const item of parsed) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const text = content.map(part => String((part as { text?: unknown }).text ?? "")).join("");
    for (const match of text.matchAll(/<([a-z_]+)>([\s\S]*?)<\/\1>/g)) {
      sections.set(match[1]!, match[2]!.trim());
    }
    // AGENTS.md is NOT tagged: it arrives as a plain `# AGENTS.md instructions
    // for <path>` block among the tagged sections. Matching only on tags would
    // report the layer as unrendered while its text sits in the same message.
    const projectDoc = /(^|\n)(# AGENTS\.md instructions for [\s\S]*)$/.exec(
      text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/g, ""),
    );
    if (projectDoc) sections.set("__agents_md", projectDoc[2]!.trim());
  }
  return sections;
}

/**
 * Probe once and map every known layer to its rendered text.
 *
 * `cwd` matters: AGENTS.md and environment context are directory-dependent, so a
 * probe from the wrong place would describe a prompt the user never sees.
 */
export async function probePromptText(cwd: string, timeoutMs = 15_000): Promise<PromptTextProbe> {
  const binary = resolveCodexBinary();
  if (!binary) {
    return { ok: false, cwd, layers: {}, detail: "codex binary not found" };
  }
  const raw = await runProbe(binary, cwd, timeoutMs);
  if (raw === null) {
    return { ok: false, cwd, layers: {}, detail: "codex debug prompt-input failed" };
  }
  const sections = extractSections(raw);
  const layers: Record<string, LayerText> = {};
  for (const [layerId, tag] of Object.entries(LAYER_SECTION_TAGS)) {
    const text = sections.get(tag) ?? null;
    layers[layerId] = text === null
      // Registered but not rendered on this turn, which is an ordinary state for
      // a diff-rendered section rather than an error.
      ? { text: null, reason: "not-rendered", bytes: 0 }
      : { text, reason: "ok", bytes: Buffer.byteLength(text, "utf8") };
  }
  // The base prompt travels outside prompt.input and cannot be read this way.
  layers["base-instructions"] = { text: null, reason: "not-exposed", bytes: 0 };
  return { ok: true, cwd, layers };
}
