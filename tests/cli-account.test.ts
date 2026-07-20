import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cmdAccount, classifyAccount, formatAccountTable } from "../src/cli/account";
import type { OcxConfig } from "../src/types";

/**
 * Issue #180 core matrix (devlog 010). Mock management API; raw sentinel secret
 * lives only in the config fixture — output must never contain it.
 */
const RAW_SENTINEL = "sk-rawsentinel1234567890";

const requests: { method: string; path: string; body?: unknown }[] = [];

function cfg(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: { adapter: "openai-responses", baseUrl: "http://x/v1", authMode: "forward" },
      anthropic: { adapter: "anthropic", baseUrl: "http://x", authMode: "oauth" },
      kiro: { adapter: "anthropic", baseUrl: "http://x", authMode: "oauth" },
      openrouter: { adapter: "openai-chat", baseUrl: "http://x/v1", authMode: "key", apiKey: RAW_SENTINEL },
      ollama: { adapter: "ollama", baseUrl: "http://x", authMode: "local" },
      "fwd-custom": { adapter: "openai-chat", baseUrl: "http://x/v1", authMode: "forward" },
    },
  } as unknown as OcxConfig;
}

let server: Server;
let baseUrl: string;
let codexActiveId: string | null = "chatgpt-1";

function route(pathname: string, query: URLSearchParams): { status: number; body: unknown } {
  if (pathname === "/api/codex-auth/accounts") {
    return { status: 200, body: { accounts: [
      { id: "__main__", email: "m***@x.com", plan: "plus", isMain: true, hasCredential: true, quota: null },
      { id: "chatgpt-1", email: "j***@y.com", plan: "free", isMain: false, hasCredential: true, quota: null, needsReauth: true },
    ] } };
  }
  if (pathname === "/api/codex-auth/active") {
    return { status: 200, body: { activeCodexAccountId: codexActiveId, autoSwitchThreshold: 80, upstreamFailoverThreshold: 3 } };
  }
  if (pathname === "/api/oauth/providers") return { status: 200, body: { providers: ["anthropic", "kiro", "xai"] } };
  if (pathname === "/api/oauth/accounts") {
    const provider = query.get("provider");
    if (provider === "anthropic") return { status: 200, body: { activeAccountId: "acct_1", accounts: [
      { id: "acct_1", email: "a***@z.com", active: true },
      { id: "acct_2", active: false },
    ] } };
    if (provider === "kiro") return { status: 200, body: { activeAccountId: "kiro_1", accounts: [{ id: "kiro_1", active: true }] } };
    return { status: 200, body: { activeAccountId: null, accounts: [] } };
  }
  if (pathname === "/api/providers/keys") {
    if (query.get("name") === "openrouter") return { status: 200, body: { activeId: "key_1", keys: [
      { id: "key_1", label: "personal", masked: "sk-ra****7890", active: true },
    ] } };
    return { status: 404, body: { error: "unknown provider" } };
  }
  return { status: 404, body: { error: "not found" } };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsedBody = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? "GET", path: url.pathname, body: parsedBody });
      let out: { status: number; body: unknown };
      if (req.method === "PUT" && url.pathname === "/api/codex-auth/active") {
        const accountId = (parsedBody as { accountId?: string }).accountId;
        out = accountId === "nope" ? { status: 400, body: { error: "Account not found" } }
          : { status: 200, body: { ok: true, activeCodexAccountId: accountId } };
      } else if (req.method === "PUT" && url.pathname === "/api/oauth/accounts/active") {
        const accountId = (parsedBody as { accountId?: string }).accountId;
        out = accountId === "nope" ? { status: 404, body: { error: "account not found" } }
          : { status: 200, body: { ok: true, provider: "anthropic", activeAccountId: accountId } };
      } else if (req.method === "PUT" && url.pathname === "/api/providers/keys/active") {
        const id = (parsedBody as { id?: string }).id;
        out = id === "nope" ? { status: 404, body: { error: "key not found" } }
          : { status: 200, body: { ok: true, name: "openrouter", activeId: id } };
      } else {
        out = route(url.pathname, url.searchParams);
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

function capture(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  return { lines, errors, restore: () => { console.log = origLog; console.error = origErr; } };
}

const deps = () => ({ baseUrl, loadConfigImpl: cfg });
const out = (c: ReturnType<typeof capture>) => [...c.lines, ...c.errors].join("\n");

beforeAll(() => { requests.length = 0; });

describe("ocx account core (issue #180)", () => {
  test("1: list shows all three families with main display + padded table", async () => {
    const c = capture();
    const code = await cmdAccount(["list"], deps());
    c.restore();
    expect(code).toBe(0);
    const text = c.lines.join("\n");
    expect(text).toContain("PROVIDER");
    expect(text).toContain("openai");
    expect(text).toContain("codex");
    expect(text).toContain("main");
    expect(text).toContain("chatgpt-1");
    expect(text).toContain("anthropic");
    expect(text).toContain("acct_1");
    expect(text).toContain("openrouter");
    expect(text).toContain("key_1");
    expect(text).toContain("next session");
    expect(text).toContain("needs-reauth");
    // xai has zero accounts → skipped silently without --all
    expect(text).not.toContain("xai");
  });

  test("2: list --json parses and keeps the raw __main__ id", async () => {
    const c = capture();
    const code = await cmdAccount(["list", "--json"], deps());
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.lines.join("\n"));
    const ids = parsed.accounts.map((a: { id: string }) => a.id);
    expect(ids).toContain("__main__");
    expect(ids).toContain("acct_1");
    expect(ids).toContain("key_1");
  });

  test("3: --all surfaces zero-row providers as notes", async () => {
    const c = capture();
    const code = await cmdAccount(["list", "--all"], deps());
    c.restore();
    expect(code).toBe(0);
    expect(out(c)).toContain("xai: no stored accounts or keys");
  });

  test("4: current openai prints the pinned account", async () => {
    codexActiveId = "chatgpt-1";
    const c = capture();
    const code = await cmdAccount(["current", "openai"], deps());
    c.restore();
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("chatgpt-1");
    expect(c.lines.join("\n")).toContain("next session");
  });

  test("5: current openai with null pin prints the auto note", async () => {
    codexActiveId = null;
    const c = capture();
    const code = await cmdAccount(["current", "openai"], deps());
    c.restore();
    codexActiveId = "chatgpt-1";
    expect(code).toBe(0);
    expect(out(c)).toContain("auto (no pin");
  });

  test("6: use anthropic sends the oauth PUT body and exits 0", async () => {
    requests.length = 0;
    const c = capture();
    const code = await cmdAccount(["use", "anthropic", "acct_2"], deps());
    c.restore();
    expect(code).toBe(0);
    const put = requests.find(r => r.method === "PUT" && r.path === "/api/oauth/accounts/active");
    expect(put?.body).toEqual({ provider: "anthropic", accountId: "acct_2" });
  });

  test("7: use openai main maps to the __main__ sentinel", async () => {
    requests.length = 0;
    const c = capture();
    const code = await cmdAccount(["use", "openai", "main"], deps());
    c.restore();
    expect(code).toBe(0);
    const put = requests.find(r => r.method === "PUT" && r.path === "/api/codex-auth/active");
    expect(put?.body).toEqual({ accountId: "__main__" });
    expect(out(c)).toContain("new Codex sessions");
    expect(out(c)).toContain("auto-switch (threshold 80%) may override");
  });

  test("8: unknown provider exits 1 and names candidates", async () => {
    const c = capture();
    const code = await cmdAccount(["use", "nosuch", "x"], deps());
    c.restore();
    expect(code).toBe(1);
    expect(out(c)).toContain('unknown provider "nosuch"');
    expect(out(c)).toContain("openai");
  });

  test("9: unknown account surfaces the server error and exits 1", async () => {
    const c = capture();
    const code = await cmdAccount(["use", "anthropic", "nope"], deps());
    c.restore();
    expect(code).toBe(1);
    expect(out(c)).toContain("account not found");
  });

  test("10: proxy down exits 1 with start/ensure guidance", async () => {
    const c = capture();
    const code = await cmdAccount(["list"], { baseUrl: "http://127.0.0.1:1", loadConfigImpl: cfg });
    c.restore();
    expect(code).toBe(1);
    expect(out(c)).toContain("ocx start");
    expect(out(c)).toContain("ocx ensure");
  });

  test("11: no output path ever prints the raw sentinel secret", async () => {
    for (const argv of [["list"], ["list", "--json"], ["current", "openrouter"], ["list", "--all"]]) {
      const c = capture();
      await cmdAccount(argv, deps());
      c.restore();
      expect(out(c)).not.toContain(RAW_SENTINEL);
      expect(out(c)).not.toContain("rawsentinel");
    }
  });

  test("12: kiro list prints the replacement-style single-slot note", async () => {
    const c = capture();
    const code = await cmdAccount(["list", "kiro"], deps());
    c.restore();
    expect(code).toBe(0);
    expect(out(c)).toContain("single login slot");
  });

  test("13: usage errors exit 1 with usage text", async () => {
    for (const argv of [[], ["use", "openai"], ["current"], ["list", "openai", "--bogus"]]) {
      const c = capture();
      const code = await cmdAccount(argv, deps());
      c.restore();
      expect(code).toBe(1);
      expect(out(c)).toContain("Usage:");
    }
  });

  test("14: fan-out skips local/forward providers silently; explicit list ollama errors", async () => {
    const c = capture();
    const code = await cmdAccount(["list"], deps());
    c.restore();
    expect(code).toBe(0);
    expect(out(c)).not.toContain("ollama");
    expect(out(c)).not.toContain("fwd-custom");
    const c2 = capture();
    const code2 = await cmdAccount(["list", "ollama"], deps());
    c2.restore();
    expect(code2).toBe(1);
    expect(out(c2)).toContain("no credentials");
  });

  test("classifyAccount: key-overridden oauth provider routes to api-key (audit R1#1)", () => {
    const config = cfg();
    (config.providers as Record<string, { authMode?: string }>).xai = { authMode: "key" };
    expect(classifyAccount(config, "xai")).toEqual({ type: "api-key" });
    expect(classifyAccount(config, "anthropic")).toEqual({ type: "oauth" });
    expect(classifyAccount(config, "openai")).toEqual({ type: "codex" });
    expect(classifyAccount(config, "ollama")).toHaveProperty("error");
  });

  test("formatAccountTable: __main__ renders as main", () => {
    const table = formatAccountTable([
      { provider: "openai", type: "codex", id: "__main__", label: "plus", active: true },
    ]);
    expect(table).toContain("main");
    expect(table).not.toContain("__main__");
    expect(table).toContain("next session");
  });
});
