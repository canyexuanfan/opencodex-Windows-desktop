import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import type { OcxConfig } from "../src/types";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import { NativeProfileError } from "../src/codex/native-profile-types";
import { resetLifecycleDrainStateForTests, setDraining, tryAdmitTurn } from "../src/server/lifecycle";
import {
  completeNativeMainRecovery,
  initializeNativeMainStartupGate,
  nativeMainStartupGateSnapshot,
} from "../src/codex/native-profile-startup";

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  resetLifecycleDrainStateForTests();
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

  test("real drain timeout leaves an admitted HTTP response live and never enters switch", async () => {
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    let switched = 0;
    const manager = { switch: async () => { switched += 1; return { ok: true }; } } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    try {
      const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
        manager,
        drainTimeoutMs: 0,
      });
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({ code: "MAIN_REQUESTS_ACTIVE", retryable: true });
      expect(switched).toBe(0);
    } finally {
      lease?.release();
    }
  });

  test("stale HTTP/Responses-WebSocket work settles before switch and new turns stay fenced", async () => {
    const oldTurn = tryAdmitTurn();
    expect(oldTurn).not.toBeNull();
    const order: string[] = [];
    let slept = false;
    let after: ReturnType<typeof tryAdmitTurn> = null;
    try {
      const manager = {
        switch: async () => { order.push("switch"); return { ok: true }; },
      } as unknown as NativeProfileManager;
      const request = new Request("http://localhost/api/native-main-profiles/switch", {
        method: "POST",
        body: JSON.stringify({ target: "target", confirmedStopped: true }),
      });
      const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
        manager,
        drainTimeoutMs: 1_000,
        sleep: async () => {
          if (slept) return Bun.sleep(1);
          slept = true;
          expect(tryAdmitTurn()).toBeNull();
          order.push("old-http-or-ws-response-finished");
          oldTurn?.release();
        },
      });
      expect(response?.status).toBe(200);
      expect(order).toEqual(["old-http-or-ws-response-finished", "switch"]);
      after = tryAdmitTurn();
      expect(after).not.toBeNull();
    } finally {
      oldTurn?.release();
      after?.release();
    }
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
    expect(payload).not.toContain(userInfo().username);
  });

  test("pending-recovery errors retain actionable public recovery commands", async () => {
    const message = "A native-profile recovery journal is pending. Run `ocx account main recover` or `ocx account main recover --rollback --yes` before registering or adding profiles.";
    const manager = {
      register: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", message, 409); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/register", {
      method: "POST",
      body: JSON.stringify({ label: "personal" }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "RECOVERY_REQUIRED", error: message });
  });

  test("successful switch auto-recovery completes the matching startup gate before releasing its drain lease", async () => {
    const homeId = "home-switch-gate";
    await initializeNativeMainStartupGate({
      manager: {
        context: { homeId, journalPath: "pending" },
        recover: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", "manual", 409); },
      } as unknown as NativeProfileManager,
      inspectJournal: () => "present",
    });
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "blocked", homeId });
    let completedWhileDraining = false;
    const manager = {
      context: { homeId, journalPath: "pending" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      inspectRecoveryJournal: () => "present",
      completeRecovery: id => {
        completedWhileDraining = tryAdmitTurn() === null;
        return completeNativeMainRecovery(id);
      },
    });
    expect(response?.status).toBe(200);
    expect(completedWhileDraining).toBe(true);
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "ready", homeId });
  });

  test("switch without auto-recovery does not complete a blocked startup gate", async () => {
    let completions = 0;
    const manager = {
      context: { homeId: "home-no-journal", journalPath: "missing" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      inspectRecoveryJournal: () => "absent",
      completeRecovery: () => { completions += 1; return true; },
    });
    expect(response?.status).toBe(200);
    expect(completions).toBe(0);
  });

  test("unknown failures use a fixed redacted internal code while typed recovery remains distinct", async () => {
    const secret = "C:\\Users\\Private\\.codex\\auth.json bearer-secret";
    const manager = {
      list: async () => { throw new Error(secret); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles");
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });
    expect(response?.status).toBe(500);
    const payload = await response?.json() as { code: string; error: string };
    expect(payload).toEqual({ code: "INTERNAL_ERROR", error: "Native-profile operation failed." });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });
});
