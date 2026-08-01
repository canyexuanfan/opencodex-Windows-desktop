import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdAccount } from "../src/cli/account";

const originalLog = console.log;
const originalError = console.error;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

describe("ocx account main", () => {
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
  });
});
