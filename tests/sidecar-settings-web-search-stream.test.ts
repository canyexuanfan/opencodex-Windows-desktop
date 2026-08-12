import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

async function getSidecarSettings(config: OcxConfig): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url), url, config);
  if (!response) throw new Error("sidecar settings route did not handle GET");
  return response;
}

async function putSidecarSettings(config: OcxConfig, webSearch: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webSearch }),
    }),
    url,
    config,
  );
  if (!response) throw new Error("sidecar settings route did not handle PUT");
  return response;
}

function emptyConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "none",
    providers: {},
    ...overrides,
  } as OcxConfig;
}

describe("sidecar-settings webSearch.streamRoutedModelOutput", () => {
  let previousHome: string | undefined;
  let isolatedHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = mkdtempSync(join(tmpdir(), "ocx-sidecar-ws-stream-"));
    process.env.OPENCODEX_HOME = isolatedHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    isolatedHome = undefined;
  });

  test("GET reports false when unset and true when configured", async () => {
    const off = await getSidecarSettings(emptyConfig());
    expect(off.status).toBe(200);
    expect(((await off.json()) as { webSearch: { streamRoutedModelOutput: boolean } })
      .webSearch.streamRoutedModelOutput).toBe(false);

    const on = await getSidecarSettings(emptyConfig({
      webSearchSidecar: { streamRoutedModelOutput: true },
    }));
    expect(((await on.json()) as { webSearch: { streamRoutedModelOutput: boolean } })
      .webSearch.streamRoutedModelOutput).toBe(true);
  });

  test("PUT true persists the flag and echoes it; PUT false removes the key", async () => {
    const config = emptyConfig();
    const enable = await putSidecarSettings(config, { streamRoutedModelOutput: true });
    expect(enable.status).toBe(200);
    expect(((await enable.json()) as { webSearch: { streamRoutedModelOutput: boolean } })
      .webSearch.streamRoutedModelOutput).toBe(true);
    expect(config.webSearchSidecar?.streamRoutedModelOutput).toBe(true);

    const disable = await putSidecarSettings(config, { streamRoutedModelOutput: false });
    expect(disable.status).toBe(200);
    expect(((await disable.json()) as { webSearch: { streamRoutedModelOutput: boolean } })
      .webSearch.streamRoutedModelOutput).toBe(false);
    // false is the default — the key is dropped so config files stay minimal.
    expect("streamRoutedModelOutput" in (config.webSearchSidecar ?? {})).toBe(false);
  });

  test("PUT rejects a non-boolean value and leaves other fields untouched", async () => {
    const config = emptyConfig({ webSearchSidecar: { model: "gpt-5.6-luna" } });
    const response = await putSidecarSettings(config, { streamRoutedModelOutput: "yes" });
    expect(response.status).toBe(400);
    expect(config.webSearchSidecar?.streamRoutedModelOutput).toBeUndefined();
    expect(config.webSearchSidecar?.model).toBe("gpt-5.6-luna");
  });

  test("PUT that omits the flag does not disturb an enabled value", async () => {
    const config = emptyConfig({ webSearchSidecar: { streamRoutedModelOutput: true } });
    const response = await putSidecarSettings(config, { model: "gpt-5.6-luna" });
    expect(response.status).toBe(200);
    expect(config.webSearchSidecar?.streamRoutedModelOutput).toBe(true);
  });
});
