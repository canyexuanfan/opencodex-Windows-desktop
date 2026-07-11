/**
 * `ocx claude [claude args...]` — launch Claude Code wired to the local proxy.
 *
 * Mirrors `ccr code` UX (devlog/260711_claude_inbound/020, 003 E1/E2/E5/G1):
 * ensures the proxy is running, injects the Anthropic env slots, then execs the
 * `claude` CLI with stdio inherited. User-exported env always wins.
 */
import { spawn } from "node:child_process";
import { loadConfig } from "../config";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

export interface ClaudeLaunchEnv {
  [key: string]: string | undefined;
}

/**
 * Pure env assembly (unit-tested): never sets ANTHROPIC_API_KEY (setting both
 * token vars triggers Claude Code's auth-conflict warning, 003 E1), and never
 * overrides variables the user already exported.
 */
export function buildClaudeEnv(config: OcxConfig, port: number, base: ClaudeLaunchEnv): ClaudeLaunchEnv {
  const env: ClaudeLaunchEnv = { ...base };
  const setDefault = (name: string, value: string | undefined) => {
    if (value === undefined || value.length === 0) return;
    if (env[name] !== undefined && env[name] !== "") return; // user wins
    env[name] = value;
  };
  setDefault("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
  const authToken = config.apiKeys?.[0]?.key ?? process.env.OPENCODEX_API_AUTH_TOKEN ?? "opencodex-local";
  setDefault("ANTHROPIC_AUTH_TOKEN", authToken);
  // Native /model picker discovery ("From gateway", Claude Code >= 2.1.129).
  setDefault("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1");
  setDefault("ANTHROPIC_MODEL", config.claudeCode?.model);
  // Current slot var + deprecated legacy name for older Claude Code versions.
  setDefault("ANTHROPIC_DEFAULT_HAIKU_MODEL", config.claudeCode?.smallFastModel);
  setDefault("ANTHROPIC_SMALL_FAST_MODEL", config.claudeCode?.smallFastModel);
  return env;
}

async function ensureProxyForClaude(): Promise<number | null> {
  const live = await findLiveProxy();
  if (live) return live.port;
  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started.port;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

export async function cmdClaude(args: string[]): Promise<number> {
  const config = loadConfig();
  if (config.claudeCode?.enabled === false) {
    console.error("Claude inbound is disabled (config.claudeCode.enabled=false — flip the Claude ON toggle in the GUI or edit config).");
    return 1;
  }
  const port = await ensureProxyForClaude();
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }
  const env = buildClaudeEnv(config, port, process.env);
  return await new Promise<number>(resolve => {
    const child = spawn("claude", args, { stdio: "inherit", env: env as NodeJS.ProcessEnv });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error("❌ `claude` CLI not found. Install it first: npm install -g @anthropic-ai/claude-code");
      } else {
        console.error(`❌ Failed to launch claude: ${err.message}`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : code ?? 0);
    });
  });
}
