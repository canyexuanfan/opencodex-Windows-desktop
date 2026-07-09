/**
 * /api/injection-model effort support (devlog/260710_injection_effort):
 * PUT validates the reasoning effort against the Codex ladder, clears it with the
 * model, and GET surfaces `{ effort, efforts }` next to the existing model picker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { CODEX_REASONING_LEVELS } from "../src/reasoning-effort";
import type { OcxConfig } from "../src/types";

const savedHome = process.env.OPENCODEX_HOME;
let tempHome: string | null = null;

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) { rmSync(tempHome, { recursive: true, force: true }); tempHome = null; }
});

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-injection-"));
  process.env.OPENCODEX_HOME = tempHome;
}

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

async function put(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/injection-model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

describe("/api/injection-model reasoning effort", () => {
  test("PUT model+effort roundtrips; GET surfaces effort + ladder", async () => {
    isolatedHome();
    const config = makeConfig();
    const putRes = await put(config, { model: "openai/gpt-5.6-sol", effort: "xhigh" });
    expect(await putRes.json()).toEqual({ ok: true, model: "openai/gpt-5.6-sol", effort: "xhigh" });
    expect(config.injectionEffort).toBe("xhigh");

    const getRes = await handleManagementAPI(
      new Request("http://localhost/api/injection-model"), new URL("http://localhost/api/injection-model"), config,
    );
    const data = await getRes!.json() as { model: string | null; effort: string | null; efforts: string[] };
    expect(data.model).toBe("openai/gpt-5.6-sol");
    expect(data.effort).toBe("xhigh");
    expect(data.efforts).toEqual(CODEX_REASONING_LEVELS.map(l => l.effort));
  });

  test("invalid effort is rejected with 400 and leaves config untouched", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "high" });
    const res = await put(config, { model: "anthropic/claude-sonnet-5", effort: "turbo" });
    expect(res.status).toBe(400);
    expect(config.injectionModel).toBe("openai/gpt-5.6-sol");
    expect(config.injectionEffort).toBe("high");
  });

  test("clearing the effort alone keeps the model", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "max" });
    const res = await put(config, { model: "openai/gpt-5.6-sol", effort: null });
    expect(await res.json()).toEqual({ ok: true, model: "openai/gpt-5.6-sol", effort: null });
    expect(config.injectionEffort).toBeUndefined();
  });

  test("clearing the model clears the effort too", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "max" });
    const res = await put(config, { model: null });
    expect(await res.json()).toEqual({ ok: true, model: null, effort: null });
    expect(config.injectionModel).toBeUndefined();
    expect(config.injectionEffort).toBeUndefined();
  });

  test("effort key absent leaves a stored effort unchanged while the model stays", async () => {
    isolatedHome();
    const config = makeConfig({ injectionModel: "openai/gpt-5.6-sol", injectionEffort: "ultra" });
    const res = await put(config, { model: "anthropic/claude-sonnet-5" });
    expect(await res.json()).toEqual({ ok: true, model: "anthropic/claude-sonnet-5", effort: "ultra" });
  });
});
