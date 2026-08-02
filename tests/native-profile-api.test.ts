import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import { setDraining, tryAdmitTurn } from "../src/server/lifecycle";

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  setDraining(false);
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe("native main profile management API", () => {
  test("the shared admission gate rejects new turns during a native-profile drain", () => {
    setDraining(true);
    expect(tryAdmitTurn()).toBeNull();

    setDraining(false);
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    lease?.release();
  });

  test("length-unknown native-profile bodies use the bounded management reader", async () => {
    let registered = false;
    const manager = {
      register: async () => { registered = true; return { ok: true }; },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "large", padding: "x".repeat(4 * 1024 * 1024 + 1) }),
    });
    expect(request.headers.has("content-length")).toBe(false);

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });

    expect(response?.status).toBe(413);
    expect(registered).toBe(false);
  });

  test("constructor failures remain inside the redacted management error boundary", async () => {
    const missingHome = join(tmpdir(), `ocx-native-profile-missing-${crypto.randomUUID()}`);
    process.env.CODEX_HOME = missingHome;
    const request = new Request("http://localhost/api/native-main-profiles");

    const response = await handleNativeProfileAPI(
      request,
      new URL(request.url),
      {} as OcxConfig,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBeGreaterThanOrEqual(400);
    const payload = JSON.stringify(await response!.json());
    expect(payload).not.toContain(missingHome);
    expect(payload).not.toContain(process.env.USERNAME ?? "Administrator");
  });
});
