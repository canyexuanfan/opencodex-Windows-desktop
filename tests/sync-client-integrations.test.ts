import { describe, expect, test } from "bun:test";
import { claudeDesktopIntegrationEnabled, grokIntegrationEnabled } from "../src/codex/desired-state";
import type { OcxConfig } from "../src/types";

/**
 * `ocx sync` used to write the Codex catalog and stop, so a Grok fence or a Desktop profile
 * kept whatever context windows it was created with until the next `ocx start`. That gap is
 * how a catalog change (1,050,000 -> 922,000) reached Codex and nothing else.
 *
 * These pin the gate the fan-out asks and the ordering the route depends on.
 */
describe("ocx sync fans out to the client integrations that are switched on", () => {
  const base = { port: 10100, defaultProvider: "x", providers: {} } as OcxConfig;

  test("an absent toggle means ON — that is the shipped default, not an opt-in", () => {
    expect(grokIntegrationEnabled(base)).toBe(true);
    expect(claudeDesktopIntegrationEnabled(base)).toBe(true);
  });

  test("an explicit false is the only thing that takes a client out of the fan-out", () => {
    const grokOff = { ...base, clientIntegrations: { grok: false } } as OcxConfig;
    expect(grokIntegrationEnabled(grokOff)).toBe(false);
    // Turning one client off must not take the other with it.
    expect(claudeDesktopIntegrationEnabled(grokOff)).toBe(true);

    const desktopOff = { ...base, clientIntegrations: { "claude-desktop": false } } as OcxConfig;
    expect(claudeDesktopIntegrationEnabled(desktopOff)).toBe(false);
    expect(grokIntegrationEnabled(desktopOff)).toBe(true);
  });

  test("Codex runs before the clients that read its catalog, and a refused sync stops the fan-out", async () => {
    const src = await Bun.file(new URL("../src/server/management/config-routes.ts", import.meta.url)).text();
    const routeStart = src.indexOf('url.pathname === "/api/sync"');
    expect(routeStart).toBeGreaterThan(-1);
    const route = src.slice(routeStart, routeStart + 1400);

    // Ordering is load-bearing: Grok and Desktop both read the catalog Codex writes.
    expect(route.indexOf("syncModelsToCodex")).toBeLessThan(route.indexOf("syncEnabledClientIntegrations"));
    // A refused Codex sync wrote no catalog, so there is nothing new for a client to read.
    expect(route).toContain('result.status === "refused"');
  });

  test("each client is gated on its own toggle and its failure stays non-fatal", async () => {
    const src = await Bun.file(new URL("../src/server/management/config-routes.ts", import.meta.url)).text();
    const start = src.indexOf("async function syncEnabledClientIntegrations");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("\nfunction publicVisionSidecarSettings", start));

    expect(fn).toContain("grokIntegrationEnabled(config)");
    expect(fn).toContain("claudeDesktopIntegrationEnabled(config)");
    // One catch per client: a broken Grok file is a warning, not a 500 on a command whose
    // main job (the Codex catalog) succeeded.
    expect(fn.match(/catch \(error\)/g)?.length).toBe(2);
    // The Desktop write gets the native context limits, same as every other Desktop
    // call site. 8b672205e threaded `nativeContextLimits` through those writers and
    // left this assertion naming the retired `providerContextCap` spelling, so the
    // source-shape check failed against the very change it is meant to pin.
    expect(fn).toContain("nativeContextLimits(config)");
    // A client that is off is omitted rather than reported: the caller has to be able to
    // tell "left alone" from "tried and failed", so there is no skipped state to emit.
    expect(fn).not.toContain('"skipped"');
  });
});
