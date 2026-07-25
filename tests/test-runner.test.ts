import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedTestEnvironment } from "../scripts/test";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });
});
