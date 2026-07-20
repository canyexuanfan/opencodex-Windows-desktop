import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cmdAccount, classifyAccount, formatAccountTable, type AccountDeps } from "../src/cli/account";
import type { OcxConfig } from "../src/types";

const RAW_SENTINEL = "sk-rawsentinel1234567890";
const MASKED_SENTINEL = "sk-ra****7890";

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  output: string;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let activeCodexAccountId: string | null = "chatgpt_1";
let activeReadFailure: { status: number; error: string } | null = null;
let oauthListFailure: { provider: string; status: number; error: string } | null = null;
let keyListFailure: { provider: string; status: number; error: string } | null = null;
let logs: string[] = [];
let errors: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
const requests: RecordedRequest[] = [];

function fixtureConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
      },
      kiro: {
        adapter: "anthropic",
        baseUrl: "https://q.us-east-1.amazonaws.com",
        authMode: "oauth",
      },
      "github-copilot": {
        adapter: "openai-chat",
        baseUrl: "https://api.githubcopilot.com",
        authMode: "oauth",
      },
      openrouter: {
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "key",
        apiKey: RAW_SENTINEL,
      },
      ollama: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        authMode: "local",
        apiKey: RAW_SENTINEL,
      },
      "forward-custom": {
        adapter: "openai-chat",
        baseUrl: "https://forward.invalid/v1",
        authMode: "forward",
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function mockManagementApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "PUT" ? await req.json() : undefined;
  requests.push({ method: req.method, path: url.pathname, body });

  if (req.method === "GET" && url.pathname === "/api/codex-auth/accounts") {
    return json({
      accounts: [
        { id: "__main__", email: "m***@example.com", plan: "plus", isMain: true },
        { id: "chatgpt_1", email: "j***@example.com", plan: "pro", needsReauth: true },
      ],
    });
  }

  if (url.pathname === "/api/codex-auth/active") {
    if (req.method === "PUT") {
      const accountId = (body as { accountId?: string }).accountId;
      activeCodexAccountId = accountId ?? null;
      return json({ ok: true, activeCodexAccountId });
    }
    if (req.method === "GET") {
      if (activeReadFailure) return json({ error: activeReadFailure.error }, activeReadFailure.status);
      return json({ activeCodexAccountId, autoSwitchThreshold: 80 });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/oauth/providers") {
    return json({ providers: ["anthropic", "kiro", "xai"] });
  }

  if (req.method === "GET" && url.pathname === "/api/oauth/accounts") {
    const provider = url.searchParams.get("provider");
    if (oauthListFailure?.provider === provider) {
      return json({ error: oauthListFailure.error }, oauthListFailure.status);
    }
    if (provider === "anthropic") {
      return json({
        activeAccountId: "acct_1",
        accounts: [
          { id: "acct_1", email: "a***@example.com", active: true },
          { id: "acct_2", active: false },
        ],
      });
    }
    if (provider === "kiro") {
      return json({
        activeAccountId: "kiro_1",
        accounts: [{ id: "kiro_1", email: "k***@example.com", active: true }],
      });
    }
    return json({ activeAccountId: null, accounts: [] });
  }

  if (req.method === "PUT" && url.pathname === "/api/oauth/accounts/active") {
    const accountId = (body as { accountId?: string }).accountId;
    if (accountId === "nope") {
      return json({ error: "anthropic account nope was not found" }, 404);
    }
    return json({ ok: true, activeAccountId: accountId });
  }

  if (req.method === "GET" && url.pathname === "/api/providers/keys") {
    const provider = url.searchParams.get("name");
    if (keyListFailure?.provider === provider) {
      return json({ error: keyListFailure.error }, keyListFailure.status);
    }
    if (provider === "openrouter") {
      return json({
        activeId: "key_1",
        keys: [{
          id: "key_1",
          label: "personal",
          masked: MASKED_SENTINEL,
          apiKey: RAW_SENTINEL,
          active: true,
        }],
      });
    }
    return json({ error: "provider key pool not found" }, 404);
  }

  if (req.method === "PUT" && url.pathname === "/api/providers/keys/active") {
    return json({ ok: true });
  }

  return json({ error: `unhandled mock endpoint: ${req.method} ${url.pathname}` }, 404);
}

function defaultDeps(): AccountDeps {
  return { baseUrl, loadConfigImpl: fixtureConfig };
}

async function run(args: string[], deps: AccountDeps = defaultDeps()): Promise<CommandResult> {
  logs.length = 0;
  errors.length = 0;
  const code = await cmdAccount(args, deps);
  const stdout = logs.join("\n");
  const stderr = errors.join("\n");
  return { code, stdout, stderr, output: [stdout, stderr].filter(Boolean).join("\n") };
}

beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: mockManagementApi });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  activeCodexAccountId = "chatgpt_1";
  activeReadFailure = null;
  oauthListFailure = null;
  keyListFailure = null;
  requests.length = 0;
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("ocx account CLI (issue #180 matrix)", () => {
  test("1: list renders all three account families, main alias, and padded columns", async () => {
    const result = await run(["list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PROVIDER\s{2,}TYPE\s{2,}ID\s{2,}PLAN\/LABEL\s{2,}STATUS/m);
    expect(result.stdout).toMatch(/^openai\s+codex\s+main\s+plus/m);
    expect(result.stdout).toMatch(/^anthropic\s+oauth\s+acct_1\s+a\*\*\*@example\.com\s+active/m);
    expect(result.stdout).toMatch(/^openrouter\s+api-key\s+key_1\s+sk-ra\*\*\*\*7890 \(personal\)\s+active/m);
    expect(result.stdout).not.toContain("__main__");

    const lines = result.stdout.split("\n");
    const typeColumn = lines[0]!.indexOf("TYPE");
    expect(lines.find(line => line.startsWith("openai"))!.indexOf("codex")).toBe(typeColumn);
    expect(lines.find(line => line.startsWith("anthropic"))!.indexOf("oauth")).toBe(typeColumn);
    expect(lines.find(line => line.startsWith("openrouter"))!.indexOf("api-key")).toBe(typeColumn);
  });

  test("2: list --json parses and preserves the raw __main__ id", async () => {
    const result = await run(["list", "--json"]);
    const parsed = JSON.parse(result.stdout) as { accounts: Array<{ id: string; type: string }> };

    expect(result.code).toBe(0);
    expect(parsed.accounts.some(row => row.id === "__main__")).toBe(true);
    expect(new Set(parsed.accounts.map(row => row.type))).toEqual(new Set(["codex", "oauth", "api-key"]));
  });

  test("3: empty providers are skipped by default and shown with --all", async () => {
    const normal = await run(["list"]);
    const withAll = await run(["list", "--all"]);

    expect(normal.code).toBe(0);
    expect(normal.output).not.toContain("xai");
    expect(withAll.code).toBe(0);
    expect(withAll.output).toContain("xai: no stored accounts or keys");
  });

  test("4: current openai prints the pinned id and plan", async () => {
    const result = await run(["current", "openai"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chatgpt_1");
    expect(result.stdout).toContain("pro");
    expect(result.stdout).toContain("next session");
  });

  test("5: current openai explains automatic selection when active is null", async () => {
    activeCodexAccountId = null;
    const result = await run(["current", "openai"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("auto (no pin");
    expect(result.stdout).toContain("lowest-usage account is selected per request");
  });

  test("6: use anthropic acct_1 sends the OAuth PUT body and exits zero", async () => {
    const result = await run(["use", "anthropic", "acct_1"]);
    const put = requests.find(request =>
      request.method === "PUT" && request.path === "/api/oauth/accounts/active"
    );

    expect(result.code).toBe(0);
    expect(put?.body).toEqual({ provider: "anthropic", accountId: "acct_1" });
  });

  test("7: use openai main maps the alias to __main__", async () => {
    const result = await run(["use", "openai", "main"]);
    const put = requests.find(request =>
      request.method === "PUT" && request.path === "/api/codex-auth/active"
    );

    expect(result.code).toBe(0);
    expect(put?.body).toEqual({ accountId: "__main__" });
  });

  test("8: an unknown provider exits one and stderr names candidates", async () => {
    const result = await run(["use", "nosuch", "x"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown provider "nosuch"');
    expect(result.stderr).toContain("Known candidates:");
    expect(result.stderr).toContain("openai");
    expect(result.stderr).toContain("anthropic");
  });

  test("9: an OAuth API 404 exits one and surfaces the server error", async () => {
    const result = await run(["use", "anthropic", "nope"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("anthropic account nope was not found");
  });

  test("10: proxy-down exits one with ocx start and ensure guidance", async () => {
    const result = await run(
      ["list"],
      { baseUrl: "http://127.0.0.1:1", loadConfigImpl: fixtureConfig },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ocx start");
    expect(result.stderr).toContain("ocx ensure");
  });

  test("11: list projects only masked API-key DTO fields", async () => {
    const human = await run(["list"]);
    const machine = await run(["list", "--json"]);
    const parsed = JSON.parse(machine.stdout) as { accounts: Array<Record<string, unknown>> };
    const keyRow = parsed.accounts.find(row => row.type === "api-key");

    expect(human.stdout).toContain(MASKED_SENTINEL);
    expect(machine.stdout).toContain(MASKED_SENTINEL);
    expect(keyRow).not.toHaveProperty("apiKey");
    expect(human.output).not.toContain(RAW_SENTINEL);
    expect(machine.output).not.toContain(RAW_SENTINEL);
  });

  test("12: list kiro prints the single-slot replacement note", async () => {
    const result = await run(["list", "kiro"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("single login slot");
    expect(result.stdout).toContain("re-login replaces the current account");
  });

  test("13: bare account and use without an id return usage errors", async () => {
    const bare = await run([]);
    const missingId = await run(["use", "anthropic"]);

    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("Usage:");
    expect(bare.stderr).toContain("ocx account list");
    expect(missingId.code).toBe(1);
    expect(missingId.stderr).toContain("Usage:");
    expect(missingId.stderr).toContain("ocx account use");
  });

  test("14: fan-out skips local/forward providers while explicit ollama errors", async () => {
    const fanOut = await run(["list"]);
    const explicit = await run(["list", "ollama"]);

    expect(fanOut.code).toBe(0);
    expect(fanOut.output).not.toContain("ollama");
    expect(fanOut.output).not.toContain("forward-custom");
    expect(explicit.code).toBe(1);
    expect(explicit.stderr).toContain("has no credentials");
  });

  test("15: fan-out applies family- and provenance-specific error propagation", async () => {
    oauthListFailure = { provider: "anthropic", status: 401, error: "proxy authentication required" };
    const authFailure = await run(["list"]);

    expect(authFailure.code).toBe(1);
    expect(authFailure.stderr).toContain("proxy authentication required");
    expect(authFailure.stdout).toBe("");

    oauthListFailure = { provider: "anthropic", status: 400, error: "unknown oauth provider" };
    const inconsistentLiveProvider = await run(["list"]);

    expect(inconsistentLiveProvider.code).toBe(1);
    expect(inconsistentLiveProvider.stderr).toContain("unknown oauth provider");

    oauthListFailure = { provider: "github-copilot", status: 400, error: "unknown oauth provider" };
    const staleConfigOAuth = await run(["list"]);

    expect(staleConfigOAuth.code).toBe(0);
    expect(staleConfigOAuth.stderr).toBe("");

    oauthListFailure = null;
    keyListFailure = { provider: "openrouter", status: 404, error: "unknown provider" };
    const staleKeyProvider = await run(["list"]);

    expect(staleKeyProvider.code).toBe(0);
    expect(staleKeyProvider.stderr).toBe("");
  });

  test("16: a failed Codex active read is not reported as automatic selection", async () => {
    activeReadFailure = { status: 500, error: "active account read failed" };
    const result = await run(["current", "openai"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("active account read failed");
    expect(result.output).not.toContain("auto (no pin");
  });

  test("17: local providers reject credential listing even when config contains an API key", async () => {
    const result = await run(["list", "ollama"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has no credentials");
  });

  // --- Regression guards restored from the first suite (Aquinas A-gate finding 1) ---

  test("18: list marks a needsReauth codex account in the STATUS column", async () => {
    const result = await run(["list", "openai"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("chatgpt_1");
    expect(result.stdout).toContain("needs-reauth");
  });

  test("19: use openai main prints next-session and auto-switch override notes", async () => {
    const result = await run(["use", "openai", "main"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("new Codex sessions");
    expect(result.stderr).toContain("running threads keep their current account");
    expect(result.stderr).toContain("auto-switch (threshold 80%) may override this pin");
  });

  test("20: classifyAccount routes a key-overridden OAuth provider to api-key (audit R1#1)", () => {
    const config = fixtureConfig();
    (config.providers as Record<string, { authMode?: string }>).xai = { authMode: "key" };

    expect(classifyAccount(config, "xai")).toEqual({ type: "api-key" });
    expect(classifyAccount(config, "anthropic")).toEqual({ type: "oauth" });
    expect(classifyAccount(config, "openai")).toEqual({ type: "codex" });
    expect(classifyAccount(config, "ollama")).toHaveProperty("error");
    expect(classifyAccount(config, "no-such-provider")).toHaveProperty("error");
  });

  test("21: formatAccountTable renders __main__ as main with next-session status", () => {
    const table = formatAccountTable([
      { provider: "openai", type: "codex", id: "__main__", label: "plus", active: true },
    ]);

    expect(table).toContain("main");
    expect(table).not.toContain("__main__");
    expect(table).toContain("next session");
  });
});
