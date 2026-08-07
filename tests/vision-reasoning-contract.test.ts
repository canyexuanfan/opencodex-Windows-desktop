import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { listManagementModelRows } from "../src/server/management/model-rows";
import type { OcxConfig } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

async function putVision(config: OcxConfig, vision: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vision }),
    }),
    url,
    config,
  );
  if (!response) throw new Error("sidecar settings route did not handle request");
  return response;
}

/**
 * Maintainer takeover regression coverage for #1002.
 *
 * These contracts intentionally live above the GUI: capability metadata must be present on the
 * management model rows, and the management boundary must never persist a reasoning rung a known
 * native vision model cannot serve.
 */
describe("vision reasoning capability contracts", () => {
  test("native management rows expose vision-safe reasoning ladders", async () => {
    const config: OcxConfig = { port: 10100, defaultProvider: "none", providers: {} };
    const rows = await listManagementModelRows(config);
    const efforts = (id: string) => (rows.find(row => row.native === true && row.id === id) as
      | { reasoningEfforts?: string[] }
      | undefined)?.reasoningEfforts;

    expect(efforts("gpt-5.4-mini")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(efforts("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts("gpt-5.6-sol")).not.toContain("ultra");
  });

  test("management normalizes native model/effort pairs on every relevant partial update", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-reasoning-contract-"));
    process.env.OPENCODEX_HOME = isolatedHome;

    try {
      const direct = { port: 10100, defaultProvider: "none", providers: {} } as OcxConfig;
      let response = await putVision(direct, { model: "gpt-5.4-mini", reasoning: "max" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      expect(direct.visionSidecar?.reasoning).toBe("xhigh");

      const reasoningOnly = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { model: "gpt-5.4-mini", reasoning: "low" },
      } as OcxConfig;
      response = await putVision(reasoningOnly, { reasoning: "max" });
      expect(response.status).toBe(200);
      expect(reasoningOnly.visionSidecar?.reasoning).toBe("xhigh");

      const unsetModel = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { reasoning: "low" },
      } as OcxConfig;
      response = await putVision(unsetModel, { reasoning: "max" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      expect(unsetModel.visionSidecar?.model).toBeUndefined();
      expect(unsetModel.visionSidecar?.reasoning).toBe("xhigh");

      const modelOnly = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { model: "gpt-5.6-luna", reasoning: "max" },
      } as OcxConfig;
      response = await putVision(modelOnly, { model: "gpt-5.4-mini" });
      expect(response.status).toBe(200);
      expect(modelOnly.visionSidecar).toMatchObject({ model: "gpt-5.4-mini", reasoning: "xhigh" });

      const reset = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { model: "gpt-5.4-mini", reasoning: "max" },
      } as OcxConfig;
      response = await putVision(reset, { model: "" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      expect(reset.visionSidecar?.model).toBeUndefined();
      expect(reset.visionSidecar?.reasoning).toBe("xhigh");

      const custom = { port: 10100, defaultProvider: "none", providers: {} } as OcxConfig;
      response = await putVision(custom, { model: "custom-vision", reasoning: "max" });
      expect(response.status).toBe(200);
      expect(custom.visionSidecar).toMatchObject({ model: "custom-vision", reasoning: "max" });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("invalid effort is rejected without mutation and unrelated patches preserve reasoning", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-reasoning-invalid-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    const config = {
      port: 10100,
      defaultProvider: "none",
      providers: {},
      visionSidecar: { model: "gpt-5.4-mini", reasoning: "high", maxDescriptionsPerTurn: 8 },
    } as OcxConfig;

    try {
      let response = await putVision(config, { reasoning: "ultra" });
      expect(response.status).toBe(400);
      expect(config.visionSidecar).toMatchObject({ model: "gpt-5.4-mini", reasoning: "high" });

      response = await putVision(config, { maxDescriptionsPerTurn: 4 });
      expect(response.status).toBe(200);
      expect(config.visionSidecar).toMatchObject({
        model: "gpt-5.4-mini",
        reasoning: "high",
        maxDescriptionsPerTurn: 4,
      });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
