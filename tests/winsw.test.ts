import { describe, expect, test } from "bun:test";
import { buildWinswXml, ensureWinswBinary, parseWinswStatus, sha256Hex, installWinswService, WINSW_SHA256, WINSW_SERVICE_ID } from "../src/lib/winsw";
import { parseServiceArgs, serviceReinstallArgs } from "../src/service";
import { loadServiceTokenFromFile } from "../src/lib/service-secrets";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = { bun: "C:\\OpenCodex\\bun.exe", cli: "C:\\Open Codex\\cli & co\\index.ts" };

describe("winsw xml", () => {
  const env = { USERDOMAIN: "WORKGROUP", USERNAME: "jun", PATH: "C:\\bin;C:\\tools & more" } as NodeJS.ProcessEnv;

  test("registers the user service account (v2 schema), never LocalSystem", () => {
    const xml = buildWinswXml(entry, env);

    expect(xml).toContain("<serviceaccount>");
    expect(xml).toContain("<domain>WORKGROUP</domain>");
    expect(xml).toContain("<user>jun</user>");
    expect(xml).toContain("<allowservicelogon>true</allowservicelogon>");
    // v2 schema uses domain/user; v3's <username> must not appear, nor any password.
    expect(xml).not.toContain("<username>");
    expect(xml).not.toContain("<password>");
    expect(xml.toLowerCase()).not.toContain("localsystem");
  });

  test("carries service env: OCX_SERVICE, token file pointer, and escaped PATH parity", () => {
    const xml = buildWinswXml(entry, env);

    expect(xml).toContain('<env name="OCX_SERVICE" value="1"/>');
    expect(xml).toContain('<env name="OCX_API_TOKEN_FILE"');
    expect(xml).toContain('<env name="PATH" value="C:\\bin;C:\\tools &amp; more"/>');
    // The token VALUE never lands in the XML — only the file pointer.
    expect(xml).not.toContain("OPENCODEX_API_AUTH_TOKEN");
  });

  test("escapes executable/arguments and configures restart + graceful stop", () => {
    const xml = buildWinswXml(entry, env);

    expect(xml).toContain("<executable>C:\\OpenCodex\\bun.exe</executable>");
    expect(xml).toContain("<arguments>&quot;C:\\Open Codex\\cli &amp; co\\index.ts&quot; start</arguments>");
    expect(xml).toContain('<onfailure action="restart" delay="5 sec"/>');
    expect(xml).toContain("<stoptimeout>20 sec</stoptimeout>");
    expect(xml).toContain('<log mode="roll-by-size">');
    expect(xml).toContain(`<id>${WINSW_SERVICE_ID}</id>`);
  });
});

describe("winsw binary pinning", () => {
  test("download failing hash verification is fail-closed", async () => {
    const fakeFetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;

    await expect(ensureWinswBinary(fakeFetch)).rejects.toThrow(/SHA-256 verification/);
  });

  test("download network failure names the manual placement path", async () => {
    const fakeFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    await expect(ensureWinswBinary(fakeFetch)).rejects.toThrow(/Place the official WinSW\.NET461\.exe/);
  });

  test("pinned digest shape is a sha256 hex", () => {
    expect(WINSW_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("winsw status parsing", () => {
  test("maps the three v2 outputs exactly", () => {
    expect(parseWinswStatus("Started")).toBe("started");
    expect(parseWinswStatus("Stopped")).toBe("stopped");
    expect(parseWinswStatus("NonExistent")).toBe("nonexistent");
    // Unknown output is treated as not-installed rather than installed.
    expect(parseWinswStatus("garbage")).toBe("nonexistent");
  });
});

describe("winsw install flow", () => {
  test("fresh install prompts credentials via /p and verifies the account", async () => {
    const calls: string[][] = [];
    await installWinswService(entry, {
      ensureBinary: async () => "exe",
      writeXml: () => {},
      interactive: args => { calls.push(["interactive", ...args]); },
      run: args => { calls.push(["run", ...args]); return ""; },
      verifyAccount: () => { calls.push(["verify"]); },
      status: () => "nonexistent",
    });

    expect(calls).toEqual([["interactive", "install", "/p"], ["verify"], ["run", "start"]]);
  });

  test("repair over an existing service rewrites assets and restarts without re-prompting", async () => {
    const calls: string[][] = [];
    await installWinswService(entry, {
      ensureBinary: async () => "exe",
      writeXml: () => { calls.push(["xml"]); },
      interactive: args => { calls.push(["interactive", ...args]); },
      run: args => { calls.push(["run", ...args]); return ""; },
      verifyAccount: () => { calls.push(["verify"]); },
      status: () => "stopped",
    });

    expect(calls).toEqual([["xml"], ["run", "stop"], ["run", "start"]]);
  });
});

describe("service backend CLI parsing", () => {
  test("install --native selects the native backend", () => {
    expect(parseServiceArgs(["install", "--native"])).toEqual({ sub: "install", backend: "native", invalid: [] });
  });

  test("bare service defaults to install with no backend override", () => {
    expect(parseServiceArgs([])).toEqual({ sub: "install", backend: null, invalid: [] });
  });

  test("--scheduler and unknown flags are recognized separately", () => {
    expect(parseServiceArgs(["install", "--scheduler"]).backend).toBe("scheduler");
    expect(parseServiceArgs(["install", "--bogus"]).invalid).toEqual(["--bogus"]);
    expect(parseServiceArgs(["status", "--native"])).toEqual({ sub: "status", backend: "native", invalid: [] });
  });
});

describe("service reinstall args", () => {
  test("defaults to the scheduler backend on this machine (no native state)", () => {
    // On a dev machine without a native install-state the accessor maps to scheduler.
    expect(serviceReinstallArgs()).toEqual(["service", "install"]);
  });
});

describe("app-side service token loading", () => {
  test("loads the token from OCX_API_TOKEN_FILE only when the env token is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-token-"));
    const file = join(dir, "service-api-token");
    writeFileSync(file, "  tok-123  \n");
    try {
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: file })).toBe("tok-123");
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: file, OPENCODEX_API_AUTH_TOKEN: "already" })).toBeNull();
      expect(loadServiceTokenFromFile({})).toBeNull();
      expect(loadServiceTokenFromFile({ OCX_API_TOKEN_FILE: join(dir, "missing") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
