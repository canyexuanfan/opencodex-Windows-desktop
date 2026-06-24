import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../src/codex-auth-api";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-auth-collision-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_CODEX_HOME, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

async function addAccount(id: string, email: string, chatgptAccountId: string): Promise<Response> {
  const req = new Request("http://localhost/api/codex-auth/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      email,
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      chatgptAccountId,
    }),
  });
  return (await handleCodexAuthAPI(req, new URL(req.url), {} as never))!;
}

describe("codex auth account collision", () => {
  test("allows different team members that share a ChatGPT account id", async () => {
    const first = await addAccount("team-member-a", "member-a@example.test", "shared-team-account");
    expect(first.status).toBe(200);

    const second = await addAccount("team-member-b", "member-b@example.test", "shared-team-account");
    expect(second.status).toBe(200);
  });

  test("rejects the same team member added twice", async () => {
    const first = await addAccount("team-member-a", "member-a@example.test", "shared-team-account");
    expect(first.status).toBe(200);

    const duplicate = await addAccount("team-member-a-copy", "MEMBER-A@example.test", "shared-team-account");
    expect(duplicate.status).toBe(400);
    const data = await duplicate.json() as { error: string };
    expect(data.error).toContain("Account is already in the pool");
  });
});
