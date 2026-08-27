import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  HEAD_CAPABILITIES,
  capabilitiesForRoute,
  capabilityInvocation,
  capabilityRouteKeys,
} from "../src/cli/capabilities";
import { CLI_COMMANDS, findCommand } from "../src/cli/registry";
import { runCapabilities } from "../src/cli/capabilities-command";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = original; } };
}

describe("capability table is a leaf data module", () => {
  test("capabilities.ts imports nothing from src/cli", () => {
    // Each command module declares `const USAGE` at top level, evaluated at import time.
    // A cycle back into this table resolves to `undefined` under ESM instead of throwing,
    // which would silently empty the usage text that rejectArgs hands CliUsageError --
    // a degraded failure in the exact surface these issues are about.
    const src = readFileSync(join(repoRoot, "src/cli/capabilities.ts"), "utf8");
    const relative = src.match(/from\s+["']\.[^"']*["']/g) ?? [];
    expect(relative).toEqual([]);
    expect(/\bimport\s*\(/.test(src)).toBe(false);
  });

  test("every capability renders a non-empty invocation and summary", () => {
    // Guards the degraded-cycle failure mode directly: an empty string here means the
    // table resolved to undefined somewhere rather than throwing.
    const empty = CAPABILITIES.filter(c => capabilityInvocation(c).trim() === "ocx" || c.summary.trim() === "");
    expect(empty).toEqual([]);
    for (const head of HEAD_CAPABILITIES) {
      expect(head.invocations.length).toBeGreaterThan(0);
      expect(head.summary.trim().length).toBeGreaterThan(0);
      expect(head.bannerLine.trim().length).toBeGreaterThan(0);
    }
  });

  test("a capability declaring routes marks mutation consistently", () => {
    // A capability that drives only GETs must not claim to mutate, and one driving a
    // write must not claim otherwise -- the flag is what --mutating-only filters on.
    const wrong: string[] = [];
    for (const cap of CAPABILITIES) {
      if (cap.routes.length === 0) continue;
      const anyWrite = cap.routes.some(r => r.method !== "GET");
      if (anyWrite !== cap.mutates) wrong.push(capabilityInvocation(cap));
    }
    expect(wrong).toEqual([]);
  });

  test("head-handled surfaces are NOT registry commands", () => {
    // tests/cli-registry.test.ts excludes help/--help/-h as head-handled pseudo-cases,
    // and --version exits in the CLI head before dispatch. Declaring either as a
    // CLI_COMMANDS entry would break the runner-key parity assertion.
    const names = new Set(CLI_COMMANDS.map(e => e.name));
    for (const head of HEAD_CAPABILITIES) {
      for (const invocation of head.invocations) {
        expect(names.has(invocation), `${invocation} must stay head-handled`).toBe(false);
      }
    }
  });

  test("the capabilities verb itself is a registered command", () => {
    expect(findCommand("capabilities")?.name).toBe("capabilities");
    expect(CAPABILITIES.some(c => c.command[0] === "capabilities")).toBe(true);
  });
});

describe("ocx capabilities output", () => {
  test("--json emits a stable envelope with routes and flags", async () => {
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--json"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as {
      schemaVersion: number;
      capabilities: { invocation: string; routes: unknown[]; flags: unknown[]; mutates: boolean; json: string }[];
      headCapabilities?: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.capabilities.length).toBe(CAPABILITIES.length);
    expect(parsed.headCapabilities).toHaveLength(HEAD_CAPABILITIES.length);
    for (const entry of parsed.capabilities) {
      expect(entry.invocation.startsWith("ocx ")).toBe(true);
      expect(Array.isArray(entry.routes)).toBe(true);
      expect(Array.isArray(entry.flags)).toBe(true);
      expect(typeof entry.mutates).toBe("boolean");
      expect(["payload", "envelope", "none"]).toContain(entry.json);
    }
  });

  test("--route resolves to the capabilities driving that route", async () => {
    const target = "/api/codex-auth/accounts";
    expect(capabilitiesForRoute(target).length).toBeGreaterThan(0);
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--route", target, "--json"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as { route: string; capabilities: { invocation: string }[] };
    expect(parsed.route).toBe(target);
    expect(parsed.capabilities.map(c => c.invocation)).toContain("ocx account list");
  });

  test("--route accepts the flag in any argv position", async () => {
    // Order-independence is the point: positional flag reading is why
    // `ocx restore back --json` silently ignored its flag.
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--json", "--route", "/api/usage"]); } finally { cap.restore(); }
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.lines.join("\n")) as { capabilities: { invocation: string }[] };
    expect(parsed.capabilities.map(c => c.invocation)).toEqual(["ocx usage"]);
  });

  test("an unmatched route exits non-zero instead of reporting empty success", async () => {
    // Reporting success for a route no verb drives is the class of dishonesty wp2 fixed
    // in the transport layer; do not reintroduce it here.
    const cap = captureStdout();
    let code: number;
    try { code = await runCapabilities(["--route", "/api/does-not-exist", "--json"]); } finally { cap.restore(); }
    expect(code).toBe(4);
  });

  test("--mutating-only keeps only mutating capabilities", async () => {
    const cap = captureStdout();
    try { await runCapabilities(["--mutating-only", "--json"]); } finally { cap.restore(); }
    const parsed = JSON.parse(cap.lines.join("\n")) as { capabilities: { mutates: boolean }[] };
    expect(parsed.capabilities.every(c => c.mutates)).toBe(true);
  });

  test("every route a capability declares exists in the management registry", async () => {
    // The capability table must not advertise a route the server does not serve.
    const { MANAGEMENT_ROUTES } = await import("../src/server/management/route-registry");
    const declared = new Set(MANAGEMENT_ROUTES.map(r => `${r.method} ${r.path}`));
    const unknown = [...capabilityRouteKeys()].filter(k => !declared.has(k));
    expect(unknown).toEqual([]);
  });
});
