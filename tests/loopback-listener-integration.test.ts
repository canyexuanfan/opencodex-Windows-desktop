/**
 * Integration coverage for the unauthenticated loopback listener (#1102).
 *
 * The companion unit file exercises the admission and CORS helpers in isolation. That is not
 * enough for a surface that admits without a credential: helper-level tests stay green if the
 * second listener never opens, binds the wrong address, is not distinguished from the public
 * one, or serves routes outside its allowlist. These tests start real servers and speak HTTP
 * to them, so those regressions have somewhere to fail.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { findAvailablePort, PortUnavailableError } from "../src/server/ports";
import type { OcxConfig } from "../src/types";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousHome = process.env.OPENCODEX_HOME;
let testDir = "";

function baseConfig(loopbackPort: number | null): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
    ...(loopbackPort === null
      ? {}
      : { unauthenticatedLoopbackListener: { enabled: true, port: loopbackPort } }),
  } as unknown as OcxConfig;
}

/** A free port to hand the loopback listener, chosen the same way production would not reuse. */
async function freePort(): Promise<number> {
  return await findAvailablePort(0, "127.0.0.1");
}

function firstNonLoopbackIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-loopback-listener-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_API_AUTH_TOKEN = "public-secret";
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("unauthenticated loopback listener", () => {
  test("is absent unless configured, and the public listener still demands a key", async () => {
    saveConfig(baseConfig(null));
    const server = startServer(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(res.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });

  test("admits without a credential while the public listener does not", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    try {
      // Same request, two sockets, two answers. This is the whole feature.
      const viaPublic = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      expect(viaPublic.status).toBe(401);

      const viaLoopback = await fetch(`http://127.0.0.1:${loopbackPort}/v1/models`);
      expect(viaLoopback.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("refuses connections on a non-loopback interface", async () => {
    const address = firstNonLoopbackIPv4();
    if (!address) {
      // A host with no external IPv4 cannot prove this. Say so rather than pass silently:
      // a quiet skip here would let the bind address regress unnoticed on that machine.
      console.warn("[loopback-listener] no non-loopback IPv4 interface; bind-scope check not run");
      return;
    }
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    try {
      const refused = await new Promise<boolean>(resolve => {
        const socket = connect({ host: address, port: loopbackPort });
        const settle = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(2_000);
        socket.once("connect", () => settle(false));
        socket.once("error", () => settle(true));
        socket.once("timeout", () => settle(true));
      });
      expect(refused).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("serves only the four allowlisted routes", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const base = `http://127.0.0.1:${loopbackPort}`;
    try {
      // Management, dashboard and unrelated data-plane routes must not be reachable from a
      // surface that skips authentication.
      for (const path of [
        "/api/config",
        "/",
        "/healthz",
        "/readyz",
        "/v1/chat/completions",
        "/v1/messages",
        "/v1/images/generations",
        "/v1/alpha/search",
        "/v1/opencodex/artifacts/x",
        "/v1/live",
      ]) {
        const res = await fetch(`${base}${path}`, { method: "GET" });
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }

      // And the allowlisted one is genuinely reachable, so the assertions above are not
      // passing merely because nothing works.
      expect((await fetch(`${base}/v1/models`)).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("applies the loopback Host and Origin gate, not the public same-origin rule", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const url = `http://127.0.0.1:${loopbackPort}/v1/models`;
    try {
      // The kernel refuses remote TCP, but a victim's browser connects locally on an
      // attacker's behalf. Under the PUBLIC policy this same-origin shape is allowed; under
      // the loopback policy it must not be.
      const rebinding = await fetch(url, { headers: { Host: "attacker.example" } });
      expect(rebinding.status).toBe(403);

      const hostileOrigin = await fetch(url, { headers: { Origin: "http://attacker.example" } });
      expect(hostileOrigin.status).toBe(403);
      expect(hostileOrigin.headers.get("access-control-allow-origin")).not.toBe("http://attacker.example");

      const ok = await fetch(url);
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("stopping the server closes both listeners", async () => {
    const loopbackPort = await freePort();
    saveConfig(baseConfig(loopbackPort));
    const server = startServer(0);
    const publicPort = server.port;
    await server.stop(true);

    // Both ports must be rebindable. A surviving loopback listener would keep serving
    // unauthenticated traffic after shutdown reported success.
    for (const port of [publicPort, loopbackPort]) {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      probe.stop(true);
    }
  });

  test("a loopback bind failure rolls back the public listener", async () => {
    const loopbackPort = await freePort();
    const squatter = Bun.serve({
      port: loopbackPort,
      hostname: "127.0.0.1",
      fetch: () => new Response("occupied"),
    });
    saveConfig(baseConfig(loopbackPort));
    try {
      expect(() => startServer(0)).toThrow();
    } finally {
      squatter.stop(true);
    }
  });
});

describe("public port selection avoids the loopback port", () => {
  test("an explicit preference for the reserved port is refused rather than taken", async () => {
    const reserved = await freePort();
    // Free, yet must not be selected: taking it would bind the public listener onto the
    // address the loopback listener is configured for, and the loopback bind would then fail.
    await expect(findAvailablePort(reserved, "127.0.0.1", { reservedPort: reserved }))
      .rejects.toBeInstanceOf(PortUnavailableError);
  });

  test("ephemeral selection never returns the reserved port", async () => {
    const reserved = await freePort();
    for (let i = 0; i < 8; i += 1) {
      const selected = await findAvailablePort(0, "127.0.0.1", { reservedPort: reserved });
      expect(selected).not.toBe(reserved);
    }
  });

  test("an unreserved preference is still honored", async () => {
    const reserved = await freePort();
    const wanted = await freePort();
    if (wanted === reserved) return;
    expect(await findAvailablePort(wanted, "127.0.0.1", { reservedPort: reserved })).toBe(wanted);
  });
});
