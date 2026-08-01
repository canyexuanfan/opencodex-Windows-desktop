import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe("native main profile management API", () => {
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
