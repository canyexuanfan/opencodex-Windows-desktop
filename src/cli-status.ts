import { durableBunRuntime } from "./bun-runtime";
import { codexAutoStartEnabled, getConfigPath, getPidPath, readConfigDiagnostics, readPid } from "./config";
import { serviceStatusSummary } from "./service";

type HealthCheck = {
  ok: boolean;
  url: string;
  message: string;
  label: string;
};

export type CliStatusJson = {
  schemaVersion: 1;
  proxy: {
    running: boolean;
    pid: number | null;
    health: {
      ok: boolean;
      url: string;
      message: string;
    };
  };
  dashboard: { url: string };
  paths: {
    config: string;
    pid: string;
    runtime: string;
  };
  runtime: {
    source: string;
    overrideEnv?: string;
  };
  codexAutostart: boolean;
  defaultProvider: string | null;
  config: {
    source: "default" | "file" | "fallback";
    error: string | null;
  };
  service: { summary: string };
  codexShim: { summary: string };
};

export type CliStatusView = {
  json: CliStatusJson;
  proxyLabel: string;
  healthLabel: string;
};

function healthHost(hostname?: string): string {
  return !hostname || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

async function checkProxyHealth(port: number, hostname?: string): Promise<HealthCheck> {
  const url = `http://${healthHost(hostname)}:${port}/healthz`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const message = `returned HTTP ${response.status}`;
      return { ok: false, url, message, label: `${url} ${message}` };
    }
    const body = await response.json().catch(() => null) as { version?: unknown; uptime?: unknown } | null;
    const version = typeof body?.version === "string" ? ` v${body.version}` : "";
    const uptime = typeof body?.uptime === "number" ? `, uptime ${Math.round(body.uptime)}s` : "";
    const message = `ok${version}${uptime}`;
    return { ok: true, url, message, label: `${url} ${message}` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "unreachable";
    return { ok: false, url, message: reason, label: `${url} ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectStatus(): Promise<CliStatusView> {
  const configDiagnostics = readConfigDiagnostics();
  const config = configDiagnostics.config;
  const port = config.port ?? 10100;
  const pid = readPid();
  const health = await checkProxyHealth(port, config.hostname);
  const bunRuntime = durableBunRuntime();
  const serviceSummary = serviceStatusSummary();
  const { codexShimStatus } = await import("./codex-shim");
  const codexShimSummary = codexShimStatus();
  const proxyLabel = pid && health.ok
    ? `running (PID ${pid})`
    : pid
      ? `PID file points to PID ${pid}, but health check failed`
      : health.ok
        ? "reachable, but PID file is missing or stale"
        : "not running";

  return {
    proxyLabel,
    healthLabel: health.label,
    json: {
      schemaVersion: 1,
      proxy: {
        running: Boolean(pid && health.ok),
        pid,
        health: {
          ok: health.ok,
          url: health.url,
          message: health.message,
        },
      },
      dashboard: { url: `http://localhost:${port}/` },
      paths: {
        config: getConfigPath(),
        pid: getPidPath(),
        runtime: bunRuntime.path,
      },
      runtime: {
        source: bunRuntime.source,
        ...(bunRuntime.source === "override" ? { overrideEnv: bunRuntime.overrideEnv } : {}),
      },
      codexAutostart: codexAutoStartEnabled(config),
      defaultProvider: typeof config.defaultProvider === "string" ? config.defaultProvider : null,
      config: {
        source: configDiagnostics.source,
        error: configDiagnostics.error,
      },
      service: { summary: serviceSummary },
      codexShim: { summary: codexShimSummary },
    },
  };
}
