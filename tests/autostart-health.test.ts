import { describe, expect, test } from "bun:test";
import { deriveStartupHealth, startupHealthSummary } from "../src/codex/autostart-health";
import { hasInjectedCodexRouting } from "../src/codex/inject";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const base = {
  routingInjected: true,
  autostartEnabled: true,
  serviceInstalled: false,
  serviceSupported: true,
  shimInstalled: false,
  shimHealthy: false,
  platform: "win32" as const,
};

describe("Codex startup health", () => {
  test("flags injected routing without a persistent starter as restart-unsafe", () => {
    const health = deriveStartupHealth(base);
    expect(health).toMatchObject({
      status: "at-risk",
      rebootSafe: false,
      protection: "none",
      recommendedCommand: "ocx service install",
    });
    expect(startupHealthSummary(health)).toContain("AT RISK");
  });

  test("treats a background service as restart protection", () => {
    const health = deriveStartupHealth({ ...base, serviceInstalled: true });
    expect(health).toMatchObject({
      status: "protected",
      rebootSafe: true,
      protection: "service",
      recommendedCommand: null,
    });
  });

  test("classifies a healthy Windows shim as CLI-only rather than Desktop-safe", () => {
    const windowsShim = deriveStartupHealth({ ...base, shimInstalled: true, shimHealthy: true });
    expect(windowsShim).toMatchObject({ protection: "shim", shimCoverage: "cli-only", status: "at-risk" });
    const unixShim = deriveStartupHealth({ ...base, platform: "linux", shimInstalled: true, shimHealthy: true });
    expect(unixShim).toMatchObject({ protection: "shim", shimCoverage: "full", status: "protected" });
    expect(deriveStartupHealth({ ...base, shimInstalled: true, shimHealthy: false }).status).toBe("at-risk");
    expect(deriveStartupHealth({ ...base, autostartEnabled: false, shimInstalled: true, shimHealthy: true }).status).toBe("at-risk");
  });

  test("native routing has no opencodex restart dependency", () => {
    const health = deriveStartupHealth({ ...base, routingInjected: false });
    expect(health).toMatchObject({ status: "native", rebootSafe: true, protection: "none" });
  });

  test("recognizes marker-owned and legacy routing without claiming user overrides", () => {
    expect(hasInjectedCodexRouting([
      '# Auto-injected by opencodex',
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "[features]",
    ].join("\n"))).toBe(true);
    expect(hasInjectedCodexRouting([
      'model_provider = "opencodex"',
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
    ].join("\n"))).toBe(true);
    expect(hasInjectedCodexRouting('openai_base_url = "http://127.0.0.1:10100/v1"')).toBe(false);
  });

  test("exposes a secret-free startup health DTO to the dashboard", async () => {
    const url = new URL("http://localhost/api/startup-health");
    const response = await handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig,
    );
    expect(response?.status).toBe(200);

    const body = await response!.json() as Record<string, unknown>;
    expect(["native", "protected", "at-risk"]).toContain(body.status);
    expect(typeof body.rebootSafe).toBe("boolean");
    expect(typeof body.routingInjected).toBe("boolean");
    expect(body.commands).toEqual({
      installService: "ocx service install",
      installShim: "ocx codex-shim install",
      restoreNative: "ocx restore",
    });

    const serialized = JSON.stringify(body).toLowerCase();
    for (const secretName of ["api_key", "apikey", "authorization", "access_token", "refresh_token"]) {
      expect(serialized).not.toContain(secretName);
    }
  });
});
