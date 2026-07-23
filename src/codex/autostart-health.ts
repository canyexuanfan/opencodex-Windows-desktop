import { codexAutoStartEnabled } from "../config";
import { serviceStatusSummary } from "../service";
import type { OcxConfig } from "../types";
import { isCodexRoutingInjected } from "./inject";
import { diagnoseCodexShim } from "./shim";

export type StartupProtection = "service" | "shim" | "none";
export type StartupHealthStatus = "native" | "protected" | "at-risk";
export type ShimCoverage = "full" | "cli-only" | "none";

export interface StartupHealthInputs {
  routingInjected: boolean;
  autostartEnabled: boolean;
  serviceInstalled: boolean;
  serviceSupported: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  platform: NodeJS.Platform;
}

export interface StartupHealth {
  status: StartupHealthStatus;
  routingInjected: boolean;
  autostartEnabled: boolean;
  rebootSafe: boolean;
  protection: StartupProtection;
  serviceInstalled: boolean;
  shimInstalled: boolean;
  shimHealthy: boolean;
  shimCoverage: ShimCoverage;
  serviceSupported: boolean;
  platform: NodeJS.Platform;
  recommendedCommand: string | null;
  commands: {
    installService: string;
    installShim: string;
    restoreNative: string;
  };
}

const COMMANDS = {
  installService: "ocx service install",
  installShim: "ocx codex-shim install",
  restoreNative: "ocx restore",
} as const;

export function deriveStartupHealth(inputs: StartupHealthInputs): StartupHealth {
  const shimEffective = inputs.autostartEnabled && inputs.shimHealthy;
  // Windows Codex Desktop and exact codex.exe invocations bypass script wrappers.
  // A healthy shim protects supported CLI launchers there, but not the global
  // openai_base_url consumed by every Codex surface.
  const shimCoverage: ShimCoverage = !shimEffective
    ? "none"
    : inputs.platform === "win32"
      ? "cli-only"
      : "full";
  const protection: StartupProtection = inputs.serviceInstalled
    ? "service"
    : shimEffective
      ? "shim"
      : "none";
  const rebootSafe = !inputs.routingInjected || inputs.serviceInstalled || shimCoverage === "full";
  const status: StartupHealthStatus = !inputs.routingInjected
    ? "native"
    : rebootSafe
      ? "protected"
      : "at-risk";
  const recommendedCommand = status !== "at-risk"
    ? null
    : inputs.serviceSupported
      ? COMMANDS.installService
      : inputs.autostartEnabled
        ? COMMANDS.installShim
        : COMMANDS.restoreNative;
  return {
    ...inputs,
    status,
    rebootSafe,
    protection,
    shimCoverage,
    recommendedCommand,
    commands: { ...COMMANDS },
  };
}

/** Collect current machine state without mutating config, services, or shims. */
export function collectStartupHealth(config: Pick<OcxConfig, "codexAutoStart">): StartupHealth {
  const shim = diagnoseCodexShim();
  const serviceSummary = serviceStatusSummary();
  return deriveStartupHealth({
    routingInjected: isCodexRoutingInjected(),
    autostartEnabled: codexAutoStartEnabled(config),
    serviceInstalled: serviceSummary.startsWith("installed"),
    serviceSupported: !serviceSummary.startsWith("unsupported"),
    shimInstalled: shim.installed,
    shimHealthy: shim.healthy,
    platform: process.platform,
  });
}

export function startupHealthSummary(health: StartupHealth): string {
  if (health.status === "native") return "native Codex routing (no opencodex restart dependency)";
  if (health.protection === "service") return "protected by background service";
  if (health.shimCoverage === "full") return "protected by Codex launcher shim";
  if (health.shimCoverage === "cli-only") return `AT RISK for Codex Desktop after restart (launcher shim covers CLI scripts only; run '${health.commands.installService}' or '${health.commands.restoreNative}')`;
  return `AT RISK after restart (no service or healthy shim; run '${health.commands.installService}' or '${health.commands.restoreNative}')`;
}
