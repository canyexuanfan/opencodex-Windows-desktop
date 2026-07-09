import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, spyOn, test } from "bun:test";
import {
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { fetchCursorUsableModels } from "../src/adapters/cursor/live-models";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";

async function withDiscoveryServer<T>(
  handler: (stream: http2.ServerHttp2Stream) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function respond(status: number, body = new Uint8Array()): (stream: http2.ServerHttp2Stream) => void {
  return stream => {
    stream.respond({ ":status": status, "content-type": "application/proto" });
    stream.end(body);
  };
}

describe("Cursor live-model discovery hardening", () => {
  test("returns discovered models as typed success", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
      models: [create(ModelDetailsSchema, { modelId: "gpt-5.5-high" })],
    }));
    const result = await withDiscoveryServer(respond(200, body), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toEqual({ ok: true, models: ["gpt-5.5-high"] });
  });

  test("classifies authentication failures", async () => {
    const result = await withDiscoveryServer(respond(401), baseUrl =>
      fetchCursorUsableModels({ apiKey: "bad-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "auth", detail: "HTTP 401" });
  });

  test("classifies non-auth HTTP failures", async () => {
    const result = await withDiscoveryServer(respond(503), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "http", detail: "HTTP 503" });
  });

  test("classifies timeouts", async () => {
    const result = await withDiscoveryServer(stream => {
      stream.on("error", () => {});
    }, baseUrl => fetchCursorUsableModels({ apiKey: "test-token", baseUrl, timeoutMs: 20 }));

    expect(result).toMatchObject({ ok: false, error: "timeout" });
  });

  test("classifies protobuf decode failures", async () => {
    const malformed = Uint8Array.of(0x0a, 0x05, 0x01);
    const result = await withDiscoveryServer(respond(200, malformed), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toMatchObject({ ok: false, error: "decode" });
  });

  test("classifies valid empty responses", async () => {
    const body = toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {}));
    const result = await withDiscoveryServer(respond(200, body), baseUrl =>
      fetchCursorUsableModels({ apiKey: "test-token", baseUrl }));

    expect(result).toEqual({ ok: false, error: "empty" });
  });

  test("catalog warns with the failure class before preserving its degradation order", async () => {
    const providerName = "cursor-hardening-warning";
    clearModelCache(providerName);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = await withDiscoveryServer(respond(503), baseUrl => gatherRoutedModels({
        providers: {
          [providerName]: {
            adapter: "cursor",
            baseUrl,
            apiKey: "test-token",
            models: ["auto"],
          },
        },
      }));

      expect(models.some(model => model.provider === providerName && model.id === "auto")).toBe(true);
      expect(warning.mock.calls.some(args => String(args[0]).includes(
        `Cursor model discovery for "${providerName}" failed [http]`,
      ))).toBe(true);
    } finally {
      warning.mockRestore();
      clearModelCache(providerName);
    }
  });
});
