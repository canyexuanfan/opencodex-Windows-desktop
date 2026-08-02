import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdAccount } from "../src/cli/account";
import { apiError } from "../src/cli/account-api";
import { nativeMainCodexLoginInvocation } from "../src/cli/account-main";

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("ocx account main", () => {
  test("cleanup guidance requires a literal true signal", () => {
    const errors: string[] = [];
    console.error = (...values: unknown[]) => errors.push(values.join(" "));

    expect(apiError({ error: "validation failed" }, "fallback")).toBe(1);
    expect(apiError({ error: "validation failed", cleanupRequired: "true" }, "fallback")).toBe(1);
    expect(errors).toEqual([
      "Error: validation failed",
      "Error: validation failed",
    ]);

    expect(apiError({ error: "validation failed", cleanupRequired: true }, "fallback")).toBe(1);
    expect(errors.at(-1)).toBe("Warning: native-login staging cleanup is still required; run 'ocx account main doctor'.");
  });

  test("official login resolves a Windows npm shim through ComSpec", () => {
    const npmBin = "C:\\Users\\tester\\AppData\\Roaming\\npm";
    const codexShim = `${npmBin}\\codex.cmd`;
    const invocation = nativeMainCodexLoginInvocation("win32", {
      env: {
        PATH: npmBin,
        PATHEXT: ".CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      exists: path => path.toLowerCase() === codexShim.toLowerCase(),
    });

    expect(invocation.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("codex.cmd");
    expect(invocation.args[3]).toContain('^"login^"');
    expect(invocation.options).toEqual({ windowsVerbatimArguments: true });
  });

  test("add keeps the auth envelope off HTTP and switch requires explicit stopped confirmation", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage");
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
    let loginHome = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ path: url.pathname, body: requestBody });
      if (url.pathname.endsWith("/stage") && !url.pathname.endsWith("/finish")) {
        return Response.json({ stageId: "11111111-1111-4111-8111-111111111111", stagingCodexHome: stagingHome, effectiveCodexHome: join(tmpdir(), "codex-home") });
      }
      if (url.pathname.endsWith("/stage/finish")) {
        return Response.json({ effectiveCodexHome: join(tmpdir(), "codex-home"), profile: { id: "p2", label: "work", identityHint: "account-12345678", state: "inactive" } });
      }
      if (url.pathname.endsWith("/switch")) {
        return Response.json({ ok: true, activeProfile: { id: "p2", label: "work", identityHint: "account-12345678", state: "active" }, restartRequired: true });
      }
      return Response.json({ ok: true });
    };
    const deps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async (home: string) => { loginHome = home; return 0; },
    };

    expect(await cmdAccount(["main", "add", "work"], deps)).toBe(0);
    expect(loginHome).toBe(stagingHome);
    expect(requests.find(request => request.path.endsWith("/stage/finish"))?.body).toEqual({
      stageId: "11111111-1111-4111-8111-111111111111",
      label: "work",
    });
    expect(JSON.stringify(requests)).not.toContain("access_token");
    expect(JSON.stringify(requests)).not.toContain("refresh_token");

    const before = requests.length;
    expect(await cmdAccount(["main", "switch", "work"], deps)).toBe(1);
    expect(requests).toHaveLength(before);
    expect(errors.join("\n")).toContain("--yes");

    expect(await cmdAccount(["main", "switch", "work", "--yes"], deps)).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ target: "work", confirmedStopped: true });
    expect(output.join("\n")).toContain("Restart Codex App/CLI");

    const recoveryBefore = requests.length;
    expect(await cmdAccount(["main", "recover", "--rollback"], deps)).toBe(1);
    expect(requests).toHaveLength(recoveryBefore);
    expect(await cmdAccount(["main", "recover", "--rollback", "--yes"], deps)).toBe(0);
    expect(requests.at(-1)?.body).toEqual({ rollback: true, confirmedStopped: true });
  });

  test("add cancels server staging after a non-200 finish response", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-non-200");
    const requests: string[] = [];
    const errors: string[] = [];
    console.error = (...values: unknown[]) => errors.push(values.join(" "));
    const fetchImpl: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({ stageId: "22222222-2222-4222-8222-222222222222", stagingCodexHome: stagingHome });
      }
      if (path.endsWith("/stage/finish")) {
        return Response.json({ error: "validation failed", code: "AUTH_INVALID", cleanupRequired: true }, { status: 409 });
      }
      return Response.json({ ok: true });
    };

    expect(await cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async () => 0,
    })).toBe(1);
    expect(requests).toEqual([
      "/api/native-main-profiles/stage",
      "/api/native-main-profiles/stage/finish",
      "/api/native-main-profiles/stage/cancel",
    ]);
    expect(errors).toContain("Error: validation failed");
    expect(errors).toContain("Warning: native-login staging cleanup is still required; run 'ocx account main doctor'.");
  });

  test("add cancels server staging when official login aborts", async () => {
    const stagingHome = join(tmpdir(), "ocx-native-profile-stage-abort");
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/stage") && !path.endsWith("/finish")) {
        return Response.json({ stageId: "33333333-3333-4333-8333-333333333333", stagingCodexHome: stagingHome });
      }
      return Response.json({ ok: true });
    };

    expect(await cmdAccount(["main", "add", "work"], {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl,
      runCodexLoginImpl: async () => { throw new Error("login aborted"); },
    })).toBe(1);
    expect(requests).toEqual([
      "/api/native-main-profiles/stage",
      "/api/native-main-profiles/stage/cancel",
    ]);
  });
});
