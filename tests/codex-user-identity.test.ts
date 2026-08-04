import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";

let codexHome = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-user-identity-codex-home-"));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(codexHome, { recursive: true, force: true });
});

test("the effective identity is uid/SID and does not follow HOME", () => {
  const before = resolveEffectiveUserIdentity();
  process.env.HOME = join(tmpdir(), "fake-home-that-must-not-key-coordination");
  const after = resolveEffectiveUserIdentity();

  expect(after).toEqual(before);
  if (process.platform === "win32") {
    expect(after.platform).toBe("win32");
    expect("sid" in after && after.sid).toMatch(/^S-1-/);
  } else {
    expect(after).toEqual({ platform: "posix", uid: process.getuid!() });
  }
  expect(JSON.stringify(after)).not.toContain(process.env.HOME);
});

test("the coordinator resolver returns the final database path", () => {
  const canonicalHome = realpathSync.native(codexHome);
  const finalPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    canonicalHome,
  );

  expect(parse(finalPath).ext).toBe(".sqlite");
  expect(parse(finalPath).base).toMatch(/^[a-f0-9]{64}\.sqlite$/);
  expect(parse(parse(finalPath).dir).base).toBe("native-write-locks");
  expect(finalPath).toBe(resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    canonicalHome,
  ));
});
