import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

type HelpEntry = {
  usage: string;
  summary: string;
  details?: string[];
};

const helpEntries: Record<string, HelpEntry> = {
  init: { usage: "ocx init", summary: "Interactive setup for providers and Codex config injection." },
  start: { usage: "ocx start [--port <port>]", summary: "Start the proxy server and sync models to Codex." },
  stop: { usage: "ocx stop", summary: "Stop the proxy and restore native Codex config." },
  restore: {
    usage: "ocx restore [back]",
    summary: "Restore native Codex config without stopping the proxy; `restore back` re-points codex at the running proxy.",
  },
  eject: {
    usage: "ocx eject [back]",
    summary: "Restore native Codex config without stopping the proxy; `eject back` re-points codex at the running proxy.",
  },
  "recover-history": {
    usage: "ocx recover-history --legacy-openai",
    summary: "Explicitly recover pre-backup syncResumeHistory rows.",
  },
  uninstall: {
    usage: "ocx uninstall",
    summary: "Remove service/shim/config and restore native Codex.",
    details: ["Alias: ocx remove"],
  },
  remove: {
    usage: "ocx remove",
    summary: "Remove service/shim/config and restore native Codex.",
    details: ["Alias of: ocx uninstall"],
  },
  service: {
    usage: "ocx service <install|start|stop|status|uninstall|remove>",
    summary: "Run as a background service.",
    details: ["Use `ocx service status` to see diagnostics and log paths."],
  },
  "codex-shim": {
    usage: "ocx codex-shim <install|status|uninstall|remove>",
    summary: "Auto-start the proxy when `codex` launches.",
    details: ["Use `remove` as an alias for `uninstall`."],
  },
  ensure: { usage: "ocx ensure", summary: "Ensure the proxy is running and Codex config/cache are current." },
  sync: { usage: "ocx sync", summary: "Fetch provider models and inject them into Codex config." },
  "sync-cache": { usage: "ocx sync-cache", summary: "Refresh Codex's model cache from the active catalog." },
  status: { usage: "ocx status", summary: "Check proxy server status." },
  doctor: { usage: "ocx doctor", summary: "Diagnose environment/network issues (paths, WSL /mnt, proxy env, ChatGPT reachability)." },
  login: { usage: "ocx login <provider>", summary: "OAuth or API-key login for a provider." },
  logout: { usage: "ocx logout <provider>", summary: "Remove a stored provider login." },
  gui: { usage: "ocx gui", summary: "Open the opencodex dashboard." },
  update: {
    usage: "ocx update [--tag latest|preview]",
    summary: "Update opencodex. Preview installs stay on the preview tag unless overridden.",
  },
};

function packageVersion(): string {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

export function printVersion(): void {
  console.log(`opencodex ${packageVersion()}`);
}

export function printUsage(): void {
  console.log(`opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx init                    Interactive setup (provider + Codex config injection)
  ocx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ocx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ocx restore                 Restore native Codex without stopping (alias: eject)
  ocx restore back            Re-point codex at the running proxy (undo restore)
  ocx recover-history --legacy-openai
                               Explicitly recover pre-backup syncResumeHistory rows
  ocx uninstall               Remove service/shim/config and restore native Codex (alias: remove)
  ocx service <sub>           Run as a background service (install|start|stop|status|uninstall|remove)
  ocx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall|remove)
  ocx ensure                  Ensure the proxy is running and Codex config/cache are current
  ocx sync                    Fetch models from providers and inject into Codex config
  ocx sync-cache              Refresh Codex's model cache from the active catalog
  ocx status                  Check proxy server status
  ocx doctor                  Diagnose environment/network issues (WSL, proxy, ChatGPT reachability)
  ocx login <provider>        OAuth login (xai) — opens browser, stores token in ~/.opencodex/auth.json
  ocx logout <provider>       Remove a stored OAuth login
  ocx gui                     Open the opencodex dashboard
  ocx update [--tag <tag>]    Update opencodex (keeps preview installs on @preview)
  ocx help [command]          Show help
  ocx --version | -v          Print version

Examples:
  ocx init                    Set up provider and inject into Codex
  ocx start                   Start on default port (10100)
  ocx start --port 8080       Start on custom port
  ocx help service            Show service command help
  ocx sync                    Sync available models to Codex`);
}

export function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

export function printSubcommandUsage(name: string | undefined): void {
  const entry = name ? helpEntries[name] : undefined;
  if (!entry) {
    console.error(`Unknown command: ${name ?? ""}`.trim());
    printUsage();
    process.exit(1);
  }
  console.log(`Usage: ${entry.usage}\n\n${entry.summary}`);
  if (entry.details?.length) console.log(`\n${entry.details.join("\n")}`);
}
