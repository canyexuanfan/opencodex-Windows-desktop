import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { listManagementModelRows } from "../src/server/management/model-rows";
import type { OcxConfig } from "../src/types";

/**
 * Maintainer takeover regression coverage for #1002.
 *
 * These contracts intentionally live above the GUI: capability metadata must be present on the
 * management model rows, and the management boundary must never persist a reasoning rung a known
 * native vision model cannot serve.
 */
describe("vision reasoning capability contracts", () => {
  test("native management model rows expose their canonical reasoning ladders", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "none",
      providers: {},
    };

    const rows = await listManagementModelRows(config);
    const mini = rows.find(row => row.native === true && row.id === "gpt-5.4-mini") as
      | { reasoningEfforts?: string[] }
      | undefined;
    const luna = rows.find(row => row.native === true && row.id === "gpt-5.6-luna") as
      | { reasoningEfforts?: string[] }
      | undefined;

    expect(mini?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(luna?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("sidecar settings clamp a valid-but-unsupported native effort before persisting", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-reasoning-contract-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    const config = {
      port: 10100,
      defaultProvider: "none",
      providers: {},
    } as OcxConfig;

    try {
      const response = await handleManagementAPI(
        new Request("http://localhost/api/sidecar-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vision: { model: "gpt-5.4-mini", reasoning: "max" } }),
        }),
        new URL("http://localhost/api/sidecar-settings"),
        config,
      );

      expect(response?.status).toBe(200);
      const body = await response!.json() as { vision?: { model?: string; reasoning?: string } };
      expect(body.vision).toMatchObject({ model: "gpt-5.4-mini", reasoning: "xhigh" });
      expect((config.visionSidecar as { reasoning?: string } | undefined)?.reasoning).toBe("xhigh");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
