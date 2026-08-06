import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  inspectDesktop3pConfigLibrary,
  removeDesktop3pStandardPivot,
} from "../src/claude/desktop-3p";

function envFor(path: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: path };
}

test("an absent Desktop library is read-only and OFF is an idempotent no-op", () => {
  const library = join(mkdtempSync(join(tmpdir(), "ocx-desktop-remove-")), "missing");
  const options = { env: envFor(library) };
  expect(inspectDesktop3pConfigLibrary(options).kind).toBe("not_installed");
  expect(removeDesktop3pStandardPivot(options)).toMatchObject({ ok: true, changed: false, kind: "noop" });
  expect(existsSync(library)).toBe(false);
});

test("OFF selects a credential-free standard profile before deleting the owned profile and backup", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  const id = "owned-profile";
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: id, entries: [{ id, name: "opencodex" }] }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100",
    inferenceGatewayApiKey: "not-printed",
  }));
  writeFileSync(join(library, `${id}.json.bak`), "{}");

  const result = removeDesktop3pStandardPivot({ env: envFor(library) });
  expect(result).toMatchObject({ ok: true, changed: true, kind: "removed" });
  expect(existsSync(join(library, `${id}.json`))).toBe(false);
  expect(existsSync(join(library, `${id}.json.bak`))).toBe(false);
  const metadata = JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")) as { appliedId: string };
  const standard = JSON.parse(readFileSync(join(library, `${metadata.appliedId}.json`), "utf8")) as Record<string, unknown>;
  expect(standard).toEqual({});
});

test("a selected path traversal id is refused without following it", () => {
  const library = mkdtempSync(join(tmpdir(), "ocx-desktop-remove-"));
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: "../outside", entries: [] }));
  const result = inspectDesktop3pConfigLibrary({ env: envFor(library) });
  expect(result).toMatchObject({ kind: "unsafe", reason: "unsafe_applied_id" });
  expect(removeDesktop3pStandardPivot({ env: envFor(library) }).kind).toBe("unsafe");
});
