import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

type Capture = {
  url: string;
  method: string;
  authorization: string | null;
  accountId: string | null;
  body: Record<string, unknown>;
};

type MigrationReceipt = {
  backupMatchesOriginal: boolean;
  backupMode: number;
  firstProviderIds: string[];
  firstDefaultProvider: string;
  hiddenLegacy: boolean;
  marker: number;
  secondIdempotent: boolean;
  restoredByteIdentity: boolean;
  restoredLegacyParse: boolean;
  backupReused: boolean;
  remigrated: boolean;
};

function hashTree(path: string): string {
  const hash = createHash("sha256");
  if (!existsSync(path)) return hash.update("absent").digest("hex");

  const visit = (current: string): void => {
    const stat = lstatSync(current);
    const label = relative(path, current) || ".";
    hash.update(`${label}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update("dir\0");
      for (const entry of readdirSync(current).sort()) visit(join(current, entry));
      return;
    }
    hash.update("file\0");
    hash.update(readFileSync(current));
  };
  visit(path);
  return hash.digest("hex");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function responsesLifecycle(body: Record<string, unknown>): string {
  const item = {
    id: "msg_fixture",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    model: body.model,
    output: [item],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
  const frames = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "OK" },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

describe("OpenAI three-tier integration spine", () => {
  test("keeps Direct, Multi, and API ownership stable across transports and management", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-three-tier-e2e-"));
    const opencodexHome = join(root, "opencodex");
    const codexHome = join(root, "codex");
    const claudeConfigDir = join(root, "claude");
    const realClaudeDir = join(homedir(), ".claude");
    const realClaudeHashBefore = hashTree(realClaudeDir);
    const previousEnv = {
      OPENCODEX_HOME: process.env.OPENCODEX_HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    const savedFetch = globalThis.fetch;
    const captures: Capture[] = [];
    const resets: Array<() => void> = [];
    let loopbackOrigin: string | null = null;
    let server: { url: URL; stop(closeActiveConnections?: boolean): Promise<void> } | null = null;

    const loopbackTuples = new Set([
      "GET /healthz",
      "GET /api/models",
      "GET /api/logs",
      "GET /api/subagent-models",
      "GET /api/injection-model",
      "PUT /api/disabled-models",
      "PUT /api/subagent-models",
      "PUT /api/injection-model",
      "POST /v1/responses",
      "POST /v1/responses/compact",
    ]);
    const upstreamTuples = new Set([
      "POST https://chatgpt.com/backend-api/codex/responses",
      "POST https://chatgpt.com/backend-api/codex/responses/compact",
      "POST https://api.openai.com/v1/responses",
      "POST https://api.openai.com/v1/responses/compact",
    ]);

    try {
      for (const dir of [opencodexHome, codexHome, claudeConfigDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      process.env.OPENCODEX_HOME = opencodexHome;
      process.env.CODEX_HOME = codexHome;
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      const authPath = join(codexHome, "auth.json");
      writeFileSync(authPath, JSON.stringify({
        tokens: { access_token: "fixture-main-access", account_id: "fixture-main-account" },
      }) + "\n", { mode: 0o600 });
      chmodSync(authPath, 0o600);

      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const tuple = `${request.method} ${url.pathname}`;
        if (loopbackOrigin !== null && url.origin === loopbackOrigin && url.search === "" && loopbackTuples.has(tuple)) {
          return savedFetch(request);
        }
        const upstreamTuple = `${request.method} ${url.href}`;
        if (!upstreamTuples.has(upstreamTuple)) {
          throw new Error(`deny-by-default fetch blocked: ${upstreamTuple}`);
        }
        const body = await request.clone().json() as Record<string, unknown>;
        captures.push({
          url: url.href,
          method: request.method,
          authorization: request.headers.get("authorization"),
          accountId: request.headers.get("chatgpt-account-id"),
          body,
        });
        if (JSON.stringify(body.input ?? "").includes("FAIL_FIXTURE")) {
          return new Response("fixture failure", { status: 500 });
        }
        if (url.pathname.endsWith("/compact")) {
          return Response.json({ output: [], model: body.model, usage: { input_tokens: 2, output_tokens: 0 } });
        }
        if (body.stream === true) {
          return new Response(responsesLifecycle(body), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: "resp_fixture",
          object: "response",
          status: "completed",
          model: body.model,
          output: [],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        });
      }) as typeof fetch;

      const [
        configModule,
        deriveModule,
        registryModule,
        accountStore,
        authApi,
        routing,
        websocketRegistry,
        requestLog,
        catalog,
        serverModule,
        mainAccount,
        sidecar,
      ] = await Promise.all([
        import("../src/config"),
        import("../src/providers/derive"),
        import("../src/providers/registry"),
        import("../src/codex/account-store"),
        import("../src/codex/auth-api"),
        import("../src/codex/routing"),
        import("../src/codex/websocket-registry"),
        import("../src/server/request-log"),
        import("../src/codex/catalog"),
        import("../src/server"),
        import("../src/codex/main-account"),
        import("../src/providers/openai-sidecar"),
      ]);

      resets.push(
        requestLog.clearRequestLogsForTests,
        catalog.resetCatalogRuntimeStateForTests,
        routing.clearThreadAccountMap,
        routing.clearCodexUpstreamHealth,
        authApi.clearAccountQuota,
        authApi.clearCodexQuotaPrimeState,
        websocketRegistry.clearCodexWebSocketRegistry,
        () => authApi.clearAccountNeedsReauth("fixture-pool"),
        () => authApi.clearAccountNeedsReauth(mainAccount.MAIN_CODEX_ACCOUNT_ID),
      );

      const seed = (id: string) => deriveModule.providerConfigSeed(
        registryModule.PROVIDER_REGISTRY.find(entry => entry.id === id)!,
      );
      const direct = seed("openai");
      const multi = seed("openai-multi");
      const api = seed("openai-apikey");
      api.liveModels = false;
      api.apiKey = "fixture-api-key";
      const config = {
        port: 0,
        defaultProvider: "openai",
        openaiProviderTierVersion: 1 as const,
        websockets: true,
        providers: { openai: direct, "openai-multi": multi, "openai-apikey": api },
        codexAccounts: [{
          id: "fixture-pool",
          email: "pool@example.test",
          plan: "plus",
          chatgptAccountId: "fixture-pool-account",
          isMain: false,
        }],
        activeCodexAccountId: "fixture-pool",
      };
      configModule.saveConfig(config);
      accountStore.saveCodexAccountCredential("fixture-pool", {
        accessToken: "fixture-pool-access",
        refreshToken: "fixture-pool-refresh",
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: "fixture-pool-account",
      });
      authApi.updateAccountQuota("fixture-pool", 10, undefined, 10);
      authApi.updateAccountQuota(mainAccount.MAIN_CODEX_ACCOUNT_ID, 20, undefined, 20);

      const reversed = {
        ...config,
        providers: { "openai-apikey": api, "openai-multi": multi, openai: direct },
      };
      expect(sidecar.listOpenAiForwardSidecarCandidates(reversed).map(row => row.providerName))
        .toEqual(["openai", "openai-multi"]);

      server = serverModule.startServer(0);
      loopbackOrigin = new URL(server.url).origin;
      const local = (path: string, init?: RequestInit) => fetch(new URL(path, server!.url), init);
      const post = (path: string, body: unknown, headers: HeadersInit = {}) => local(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      const put = (path: string, body: unknown) => local(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect((await local("/healthz")).status).toBe(200);

      const httpCases = [
        { selected: "gpt-5.6-sol", wire: "gpt-5.6-sol", url: "https://chatgpt.com/backend-api/codex/responses", auth: "Bearer fixture-caller-main", account: null, mode: undefined },
        { selected: "openai-multi/gpt-5.6-terra", wire: "gpt-5.6-terra", url: "https://chatgpt.com/backend-api/codex/responses", auth: "Bearer fixture-pool-access", account: "fixture-pool-account", mode: undefined },
        { selected: "openai-apikey/gpt-5.6", wire: "gpt-5.6", url: "https://api.openai.com/v1/responses", auth: "Bearer fixture-api-key", account: null, mode: undefined },
        { selected: "openai-apikey/gpt-5.6-sol-pro", wire: "gpt-5.6-sol", url: "https://api.openai.com/v1/responses", auth: "Bearer fixture-api-key", account: null, mode: "pro" },
        { selected: "openai-apikey/gpt-5.6-terra-pro", wire: "gpt-5.6-terra", url: "https://api.openai.com/v1/responses", auth: "Bearer fixture-api-key", account: null, mode: "pro" },
        { selected: "openai-apikey/gpt-5.6-luna-pro", wire: "gpt-5.6-luna", url: "https://api.openai.com/v1/responses", auth: "Bearer fixture-api-key", account: null, mode: "pro" },
      ] as const;
      for (const row of httpCases) {
        const before = captures.length;
        const response = await post("/v1/responses", {
          model: row.selected,
          input: "fixture",
          stream: false,
          reasoning: { effort: "high" },
        }, { authorization: "Bearer fixture-caller-main" });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ model: row.wire });
        expect(captures).toHaveLength(before + 1);
        const capture = captures.at(-1)!;
        expect(capture).toMatchObject({ url: row.url, method: "POST", authorization: row.auth, accountId: row.account });
        expect(capture.body.model).toBe(row.wire);
        if (row.mode) expect(capture.body.reasoning).toMatchObject({ effort: "high", mode: row.mode });
      }

      const NativeWebSocket = globalThis.WebSocket;
      const expectedWsUrl = new URL("/v1/responses", server.url);
      expectedWsUrl.protocol = "ws:";
      const createFixtureSocket = (value: string | URL): WebSocket => {
        const url = new URL(value);
        if (url.href !== expectedWsUrl.href) throw new Error(`deny-by-default websocket blocked: ${url.href}`);
        return new NativeWebSocket(url, {
          headers: { authorization: "Bearer fixture-caller-main" },
        } as unknown as string[]);
      };
      const ws = createFixtureSocket(expectedWsUrl);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("fixture websocket failed to open")), { once: true });
      });
      const wsTurn = (model: string) => new Promise<Capture>((resolve, reject) => {
        const before = captures.length;
        const timer = setTimeout(() => reject(new Error(`fixture websocket timeout: ${model}`)), 2_000);
        const onMessage = (event: MessageEvent) => {
          if (!String(event.data).includes('"type":"response.completed"')) return;
          clearTimeout(timer);
          ws.removeEventListener("message", onMessage);
          if (captures.length !== before + 1) return reject(new Error(`unexpected capture count for ${model}`));
          resolve(captures.at(-1)!);
        };
        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify({ type: "response.create", model, input: "fixture" }));
      });
      expect((await wsTurn("gpt-5.6-sol")).authorization).toBe("Bearer fixture-caller-main");
      expect(websocketRegistry.getTrackedCodexWebSocketCountForAccount("fixture-pool")).toBe(0);
      expect((await wsTurn("openai-multi/gpt-5.6-terra")).authorization).toBe("Bearer fixture-pool-access");
      expect(websocketRegistry.getTrackedCodexWebSocketCountForAccount("fixture-pool")).toBe(1);
      expect((await wsTurn("openai-apikey/gpt-5.6-sol-pro")).authorization).toBe("Bearer fixture-api-key");
      expect(websocketRegistry.getTrackedCodexWebSocketCountForAccount("fixture-pool")).toBe(0);
      expect((await wsTurn("gpt-5.6-luna")).authorization).toBe("Bearer fixture-caller-main");
      expect(websocketRegistry.getTrackedCodexWebSocketCountForAccount("fixture-pool")).toBe(0);
      const closed = new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true }));
      ws.close();
      await closed;

      const compactCases = [
        { selected: "gpt-5.6-sol", wire: "gpt-5.6-sol", url: "https://chatgpt.com/backend-api/codex/responses/compact", auth: "Bearer fixture-caller-main", account: null },
        { selected: "openai-multi/gpt-5.6-terra", wire: "gpt-5.6-terra", url: "https://chatgpt.com/backend-api/codex/responses/compact", auth: "Bearer fixture-pool-access", account: "fixture-pool-account" },
        { selected: "openai-apikey/gpt-5.6", wire: "gpt-5.6", url: "https://api.openai.com/v1/responses/compact", auth: "Bearer fixture-api-key", account: null },
        { selected: "openai-apikey/gpt-5.6-sol-pro", wire: "gpt-5.6-sol", url: "https://api.openai.com/v1/responses/compact", auth: "Bearer fixture-api-key", account: null },
      ] as const;
      for (const row of compactCases) {
        const response = await post("/v1/responses/compact", {
          model: row.selected,
          input: [],
          reasoning: { effort: "high", mode: "pro" },
        }, { authorization: "Bearer fixture-caller-main" });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ model: row.wire });
        const capture = captures.at(-1)!;
        expect(capture).toMatchObject({ url: row.url, method: "POST", authorization: row.auth, accountId: row.account });
        expect(capture.body).toMatchObject({ model: row.wire });
        expect(capture.body.reasoning).toBeUndefined();
      }

      routing.recordCodexUpstreamOutcome(config, "fixture-pool", 429, { retryAfter: "60" });
      expect(routing.getCodexUpstreamHealth("fixture-pool")).toMatchObject({ lastFailureStatus: 429 });
      const directWhileCooled = await post("/v1/responses", {
        model: "gpt-5.6-sol", input: "fixture", stream: false,
      }, { authorization: "Bearer fixture-caller-main" });
      expect(directWhileCooled.status).toBe(200);
      expect(captures.at(-1)?.authorization).toBe("Bearer fixture-caller-main");
      expect(routing.getCodexUpstreamHealth("fixture-pool")).toMatchObject({ lastFailureStatus: 429 });
      const cooledMulti = await post("/v1/responses", {
        model: "openai-multi/gpt-5.6-sol", input: "fixture", stream: false,
      }, { authorization: "Bearer fixture-caller-main" });
      expect(cooledMulti.status).toBe(200);
      expect(captures.at(-1)).toMatchObject({
        authorization: "Bearer fixture-main-access",
        accountId: "fixture-main-account",
      });
      routing.clearCodexUpstreamHealth();

      const selected = "openai-apikey/gpt-5.6-sol-pro";
      expect((await put("/api/disabled-models", { models: [selected] })).status).toBe(200);
      const modelRows = await local("/api/models").then(response => response.json()) as Array<{ namespaced: string; disabled: boolean }>;
      expect(modelRows.find(row => row.namespaced === selected)).toEqual({
        ...modelRows.find(row => row.namespaced === selected),
        namespaced: selected,
        disabled: true,
      });
      expect((await put("/api/subagent-models", { models: [selected] })).status).toBe(200);
      expect(await local("/api/subagent-models").then(response => response.json())).toMatchObject({ chosen: [selected] });
      expect((await put("/api/injection-model", { model: selected, effort: "high" })).status).toBe(200);
      expect(await local("/api/injection-model").then(response => response.json())).toMatchObject({ model: selected, effort: "high" });

      const logs = await local("/api/logs").then(response => response.json()) as Array<Record<string, unknown>>;
      expect(logs.some(row => row.provider === "openai-apikey"
        && row.model === "gpt-5.6-sol-pro"
        && row.requestedModel === selected
        && row.resolvedModel === "gpt-5.6-sol")).toBe(true);
      const usageLines = existsSync(join(opencodexHome, "usage.jsonl"))
        ? readFileSync(join(opencodexHome, "usage.jsonl"), "utf8").trim().split("\n").filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, unknown>)
        : [];
      expect(usageLines.some(row => row.provider === "openai-apikey"
        && row.model === "gpt-5.6-sol-pro"
        && row.requestedModel === selected
        && row.resolvedModel === "gpt-5.6-sol")).toBe(true);

      const migrationRoot = mkdtempSync(join(tmpdir(), "ocx-three-tier-migration-"));
      try {
        const child = Bun.spawn([
          process.execPath,
          join(import.meta.dir, "fixtures/openai-three-tier-migration-child.ts"),
          join(migrationRoot, "opencodex"),
          join(migrationRoot, "codex"),
        ], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout) as MigrationReceipt).toEqual({
          backupMatchesOriginal: true,
          backupMode: 0o600,
          firstProviderIds: ["openai", "openai-multi"],
          firstDefaultProvider: "openai-multi",
          hiddenLegacy: true,
          marker: 1,
          secondIdempotent: true,
          restoredByteIdentity: true,
          restoredLegacyParse: true,
          backupReused: true,
          remigrated: true,
        });
      } finally {
        rmSync(migrationRoot, { recursive: true, force: true });
      }

      expect(captures.every(capture => upstreamTuples.has(`${capture.method} ${capture.url}`))).toBe(true);
      const evidenceDir = process.env.OCX_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(evidenceDir, "050_e2e.json"), JSON.stringify({
          schemaVersion: 1,
          verdict: "PASS",
          publicNetworkFallback: false,
          httpCases: httpCases.length,
          websocketTurns: 4,
          compactCases: compactCases.length,
          canonicalUrls: [...new Set(captures.map(capture => capture.url))].sort(),
          migrationRestore: "PASS",
          virtualIdentity: "PASS",
          reverseInsertionOrder: "PASS",
          realClaudeStateUnchanged: true,
        }, null, 2) + "\n", { mode: 0o600 });
      }
    } finally {
      try {
        if (server) await server.stop(true);
      } finally {
        globalThis.fetch = savedFetch;
        for (const reset of resets) reset();
        restoreEnv("OPENCODEX_HOME", previousEnv.OPENCODEX_HOME);
        restoreEnv("CODEX_HOME", previousEnv.CODEX_HOME);
        restoreEnv("CLAUDE_CONFIG_DIR", previousEnv.CLAUDE_CONFIG_DIR);
        rmSync(root, { recursive: true, force: true });
        expect(hashTree(realClaudeDir)).toBe(realClaudeHashBefore);
      }
    }
  }, 30_000);
});
