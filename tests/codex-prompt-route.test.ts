/**
 * Route-level contract for /api/codex-prompt (devlog 020 + 021).
 *
 * Every case injects fixture paths through `ManagementApiDeps.codexPromptPaths`, so
 * no test may resolve the real CODEX_HOME. A decoy directory with sentinel files
 * rides along and is asserted byte-identical after every verb: proving the
 * fixture changed does not prove nothing else did.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { LAYER_INVENTORY, readPromptLayers } from "../src/codex/prompt-layers";
import type { OcxConfig } from "../src/types";

const MARKER = "# Auto-injected by opencodex";
const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
const roots: string[] = [];

interface Fixture {
  configPath: string;
  storePath: string;
  decoyConfig: string;
  decoyStore: string;
  decoyHome: string;
}

function fixture(configBytes?: string, storeBytes?: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ocx-prompt-route-"));
  const decoy = mkdtempSync(join(tmpdir(), "ocx-prompt-decoy-"));
  roots.push(root, decoy);
  const configPath = join(root, "config.toml");
  const storePath = join(root, "opencodex-prompt.json");
  if (configBytes !== undefined) writeFileSync(configPath, configBytes, "utf8");
  if (storeBytes !== undefined) writeFileSync(storePath, storeBytes, "utf8");
  const decoyConfig = join(decoy, "config.toml");
  const decoyStore = join(decoy, "opencodex-prompt.json");
  writeFileSync(decoyConfig, "model = \"sentinel\"\n", "utf8");
  writeFileSync(decoyStore, "{\"layers\":[]}", "utf8");
  return { configPath, storePath, decoyConfig, decoyStore, decoyHome: decoy };
}

function storeJson(layers: unknown[]): string {
  return JSON.stringify({ layers });
}

function ownedConfig(projection: string): string {
  return MARKER + "\ndeveloper_instructions = \"" + projection + "\"\n";
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Sentinels must survive every verb. The decoy is installed as CODEX_HOME for the
 * duration of each request, so this is not a vacuous check: a regression that
 * dropped `codexPromptPaths` would fall back to CODEX_HOME and land here, on a
 * temp directory, instead of on the developer's real ~/.codex.
 */
function expectDecoyUntouched(fx: Fixture): void {
  expect(read(fx.decoyConfig)).toBe("model = \"sentinel\"\n");
  expect(read(fx.decoyStore)).toBe("{\"layers\":[]}");
}

async function call(
  method: string,
  pathname: string,
  fx: Fixture,
  body?: unknown,
): Promise<{ status: number; body: any; routed: boolean }> {
  const url = new URL("http://127.0.0.1:10100" + pathname);
  const headers: Record<string, string> = { host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // The decoy is CODEX_HOME for the duration of the call. Without this the
  // sentinel assertion proves nothing: a route that ignored the injected paths
  // would write to the developer's real home and both sentinels would still
  // match. With it, that same regression lands on the decoy and is caught.
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fx.decoyHome;
  let res: Response | null;
  try {
    res = await handleManagementAPI(req, url, config, {
      codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath },
    });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  if (!res) return { status: 404, body: null, routed: false };
  const raw = await res.text();
  const parsed: unknown = raw ? JSON.parse(raw) : null;
  expectDecoyUntouched(fx);
  return { status: res.status, body: parsed, routed: true };
}

async function revision(fx: Fixture): Promise<string> {
  const res = await call("GET", "/api/codex-prompt", fx);
  return res.body.revision as string;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("GET /api/codex-prompt", () => {
  test("1. returns the snapshot with the full inventory", async () => {
    const fx = fixture("include_apps_instructions = false\n");
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.status).toBe(200);
    expect(res.body.inventory).toHaveLength(LAYER_INVENTORY.length);
    expect(res.body.inventory.map((d: any) => d.id)).toEqual(LAYER_INVENTORY.map(d => d.id));
    expect(res.body.configPath).toBe(fx.configPath);
    expect(res.body.extensionLayersEnumerable).toBe(false);
    const apps = res.body.toggles.find((t: any) => t.id === "apps");
    expect(apps.userFileValue).toBe(false);
  });

  test("2. a missing config is a first run, not an error", async () => {
    const fx = fixture();
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.status).toBe(200);
    expect(res.body.configExists).toBe(false);
    expect(res.body.readable).toBe(true);
    for (const t of res.body.toggles) expect(t.userFileValue).toBeNull();
  });

  test("17. every drift state is reported, and GET writes nothing", async () => {
    // owned-malformed: marker-adjacent but reshaped.
    const fx = fixture(MARKER + "\ndeveloper_instructions = 'single quoted'\n");
    const before = read(fx.configPath);
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.drift).toBe("owned-malformed");
    expect(read(fx.configPath)).toBe(before);
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("17b. store-missing is reported without repairing it", async () => {
    const fx = fixture(ownedConfig("Be brief."));
    const before = read(fx.configPath);
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.drift).toBe("store-missing");
    expect(read(fx.configPath)).toBe(before);
  });
});

describe("PUT /api/codex-prompt/toggle", () => {
  test("3. flips a value and echoes the new snapshot", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(read(fx.configPath)).toContain("include_apps_instructions = false");
    const apps = res.body.snapshot.toggles.find((t: any) => t.id === "apps");
    expect(apps.userFileValue).toBe(false);
  });

  test("4. an unknown id is refused", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "no-such-layer", enabled: false, revision: rev });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_layer");
  });

  test("5. every non-config-toggle inventory id is refused, and nothing is written", async () => {
    // Ask item 9 at the API boundary. Table-driven over LAYER_INVENTORY, so a new
    // upstream layer is covered the day WP1 lists it.
    const locked = LAYER_INVENTORY.filter(d => d.class !== "config-toggle");
    expect(locked.length).toBeGreaterThan(0);
    for (const descriptor of locked) {
      const fx = fixture("");
      const rev = await revision(fx);
      const before = read(fx.configPath);
      const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: descriptor.id, enabled: false, revision: rev });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("layer_not_toggleable");
      expect(res.body.layerClass).toBe(descriptor.class);
      expect(read(fx.configPath)).toBe(before);
    }
  });

  test("6. every inventory id has one class, and every config-toggle has a key", async () => {
    // The partition guard: without it the inventory can drift into a state where
    // a row is neither switchable nor explained.
    const ids = new Set<string>();
    for (const d of LAYER_INVENTORY) {
      expect(ids.has(d.id)).toBe(false);
      ids.add(d.id);
      expect(["base", "config-toggle", "feature-gated", "runtime-conditional", "extension-unknown"]).toContain(d.class);
      if (d.class === "config-toggle") expect(typeof d.key).toBe("string");
      if (d.class === "base" || d.class === "runtime-conditional") expect(d.key).toBeNull();
    }
  });

  test("23. plugins is runtime-conditional and cannot be toggled", async () => {
    // Named regression for devlog 021 §2: 020's example called this feature-gated.
    const plugins = LAYER_INVENTORY.find(d => d.id === "plugins")!;
    expect(plugins.class).toBe("runtime-conditional");
    expect(plugins.key).toBeNull();
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "plugins", enabled: false, revision: rev });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("layer_not_toggleable");
  });

  test("9a. a stale revision is refused", async () => {
    const fx = fixture("");
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
  });

  test("10b. toggles still work when developer_instructions is unowned", async () => {
    const fx = fixture("developer_instructions = \"external\"\n");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    expect(res.status).toBe(200);
    expect(read(fx.configPath)).toContain("developer_instructions = \"external\"");
  });
});

describe("PUT /api/codex-prompt/custom", () => {
  const good = { id: "abc123", title: "House rules", body: "Be brief.", enabled: true };

  test("7. round-trips order", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: rev,
      layers: [good, { id: "def456", title: "Second", body: "Then this.", enabled: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.custom.map((l: any) => l.id)).toEqual(["abc123", "def456"]);
    expect(read(fx.configPath)).toContain("Be brief.\\n\\nThen this.");
  });

  test("8. each validation rule is enforced", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const cases: Array<[unknown, string]> = [
      ["not-an-array", "invalid_body"],
      [Array.from({ length: 33 }, (_, i) => ({ ...good, id: String(i).padStart(6, "a").slice(0, 6) })), "too_many_layers"],
      [[{ ...good, id: "BAD" }], "invalid_layer_id"],
      [[good, good], "duplicate_layer_id"],
      [[{ ...good, title: "" }], "invalid_title"],
      [[{ ...good, title: "x".repeat(81) }], "invalid_title"],
      [[{ ...good, title: "one\ntwo" }], "invalid_title"],
      [[{ ...good, body: "x".repeat(64 * 1024 + 1) }], "body_too_large"],
      [[{ ...good, enabled: "yes" }], "invalid_body"],
    ];
    for (const [layers, code] of cases) {
      const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: rev, layers });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    }
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("8b. a composed prompt over the cap is refused", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const body = "y".repeat(60 * 1024);
    const layers = ["aaaaaa", "bbbbbb", "cccccc"].map(id => ({ id, title: "big", body, enabled: true }));
    const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: rev, layers });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("composed_too_large");
  });

  test("19. a control character is rejected with its position", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: rev,
      layers: [{ ...good, body: "ok\u0007bad" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_characters");
    expect(res.body.position).toBe(2);
  });

  test("10. an unowned developer_instructions is refused", async () => {
    const fx = fixture("developer_instructions = \"hand written\"\n");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: rev, layers: [good] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("developer_instructions_not_owned");
    expect(read(fx.configPath)).toContain("hand written");
  });

  test("9b. a stale revision is refused on custom too", async () => {
    const fx = fixture("");
    const res = await call("PUT", "/api/codex-prompt/custom", fx, { revision: "sha256:stale", layers: [good] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
  });

  test("18. tabs and CRLF normalize rather than fail", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    const res = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: rev,
      layers: [{ ...good, body: "a\tb\r\nc" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.custom[0].body).toBe("a    b\nc");
  });
});

describe("POST /api/codex-prompt/adopt", () => {
  test("14. preview returns the raw line and writes nothing", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const before = read(fx.configPath);
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: false });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.preview.decodedBody).toBe("Answer in Korean.");
    expect(read(fx.configPath)).toBe(before);
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("15. adopt without confirm writes nothing", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    await call("POST", "/api/codex-prompt/adopt", fx, {});
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("15b. a confirmed adopt imports the value as one layer", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const rev = await revision(fx);
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: rev });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.custom).toHaveLength(1);
    expect(res.body.snapshot.custom[0].body).toBe("Answer in Korean.");
    expect(res.body.snapshot.developerInstructionsOwned).toBe(true);
  });

  test("16. an unsupported form is refused with path and line", async () => {
    const fx = fixture("model = \"gpt-5\"\ndeveloper_instructions = '''multi\nline'''\n");
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: await revision(fx) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("adopt_unsupported_form");
    expect(res.body.path).toBe(fx.configPath);
    expect(res.body.line).toBe(2);
  });
});

describe("POST /api/codex-prompt/repair", () => {
  test("18b. requires a matching revision", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([
      { id: "aaaaaa", title: "Old", body: "Something else.", enabled: true },
    ]));
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
  });

  test("20a. projection-stale re-projects from the store", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([
      { id: "aaaaaa", title: "Old", body: "Something else.", enabled: true },
    ]));
    const get = await call("GET", "/api/codex-prompt", fx);
    expect(get.body.drift).toBe("projection-stale");
    const preview = await call("POST", "/api/codex-prompt/repair", fx, { confirm: false });
    expect(preview.body.preview.projection).toBe("Something else.");
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: get.body.revision });
    expect(res.status).toBe(200);
    expect(res.body.snapshot.drift).toBeNull();
    expect(read(fx.configPath)).toContain("Something else.");
  });

  test("20b. store-missing previews a salvage naming its backup directory", async () => {
    const fx = fixture(ownedConfig("Be brief."));
    const preview = await call("POST", "/api/codex-prompt/repair", fx, { confirm: false });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.body).toBe("Be brief.");
    expect(preview.body.preview.unrecoverable.length).toBeGreaterThan(0);
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("20c. a stale salvage is refused before any backup file is created", async () => {
    // devlog 021 §8.1: salvageProjection writes its backup BEFORE the transaction
    // validates the revision, so the route pre-checks it.
    const fx = fixture(ownedConfig("Be brief."));
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
    const dirFiles = readdirSync(join(fx.storePath, "..")).filter(f => f.includes("salvage"));
    expect(dirFiles).toHaveLength(0);
  });

  test("21a. journal-present is refused as repair_unsupported", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([]));
    writeFileSync(fx.storePath.replace(/\.json$/, "") + ".journal", "{}", "utf8");
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: await revision(fx) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("repair_unsupported");
    expect(res.body.drift).toBe("journal-present");
  });

  test("21b. owned-malformed refuses mode replace and offers adopt", async () => {
    const fx = fixture(MARKER + "\ndeveloper_instructions = 'reshaped'\n");
    const replace = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, mode: "replace", revision: await revision(fx) });
    expect(replace.status).toBe(409);
    expect(replace.body.code).toBe("repair_unsupported");
    const adopt = await call("POST", "/api/codex-prompt/repair", fx, { confirm: false });
    expect(adopt.status).toBe(409);
    expect(adopt.body.code).toBe("adopt_unsupported_form");
  });

  test("repairing a clean file is refused", async () => {
    const fx = fixture("");
    const res = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: await revision(fx) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("nothing_to_repair");
  });
});

describe("dispatch and safety", () => {
  test("13. an unhandled path returns null so the chain continues", async () => {
    const fx = fixture("");
    const res = await call("GET", "/api/codex-prompt/nope", fx);
    expect(res.routed).toBe(false);
  });

  test("20. every mapped write error carries a client-facing status", async () => {
    // A TypeScript union does not exist at runtime, so exhaustiveness is a
    // typecheck property of Record<WriteError, number>. This asserts the values.
    const { WRITE_ERROR_STATUS_FOR_TESTS } = await import("../src/server/management/codex-prompt-routes");
    const statuses = Object.values(WRITE_ERROR_STATUS_FOR_TESTS);
    expect(statuses.length).toBeGreaterThanOrEqual(9);
    for (const status of statuses) expect(status).toBeGreaterThanOrEqual(400);
    for (const status of statuses) expect(status).toBeLessThan(500);
  });

  test("22. the injected paths are honored on every verb", async () => {
    const fx = fixture("");
    const rev = await revision(fx);
    await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    const after = readPromptLayers({ configPath: fx.configPath, storePath: fx.storePath });
    expect(after.toggles.find(t => t.id === "apps")!.userFileValue).toBe(false);
    await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: after.revision,
      layers: [{ id: "abc123", title: "T", body: "B", enabled: true }],
    });
    expect(read(fx.storePath)).toContain("abc123");
    expectDecoyUntouched(fx);
  });

  test("12. no response serializes a token, key, or account identifier", async () => {
    const fx = fixture("include_apps_instructions = false\n");
    const res = await call("GET", "/api/codex-prompt", fx);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/sk-|Bearer |access_token|account_id|refresh_token/);
  });
});

describe("020 coverage completions", () => {
  test("11. an unreadable config refuses every mutation by name", async () => {
    // chmod 000 is not honored for root, and Windows ignores the mode entirely.
    // A directory in place of the file is unreadable on every platform we ship.
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-unreadable-"));
    const decoy = mkdtempSync(join(tmpdir(), "ocx-prompt-decoy-"));
    roots.push(root, decoy);
    const configPath = join(root, "config.toml");
    mkdirSync(configPath);
    const fx: Fixture = {
      configPath,
      storePath: join(root, "opencodex-prompt.json"),
      decoyConfig: join(decoy, "config.toml"),
      decoyStore: join(decoy, "opencodex-prompt.json"),
      decoyHome: decoy,
    };
    writeFileSync(fx.decoyConfig, "model = \"sentinel\"\n", "utf8");
    writeFileSync(fx.decoyStore, "{\"layers\":[]}", "utf8");

    const get = await call("GET", "/api/codex-prompt", fx);
    expect(get.body.readable).toBe(false);

    const toggle = await call("PUT", "/api/codex-prompt/toggle", fx, {
      id: "apps", enabled: false, revision: get.body.revision,
    });
    expect(toggle.status).toBe(409);
    expect(toggle.body.code).toBe("config_unreadable");

    const custom = await call("PUT", "/api/codex-prompt/custom", fx, {
      revision: get.body.revision,
      layers: [{ id: "abc123", title: "T", body: "B", enabled: true }],
    });
    expect(custom.status).toBe(409);
    expect(custom.body.code).toBe("config_unreadable");

    const adopt = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: get.body.revision });
    expect(adopt.status).toBe(409);
    expect(adopt.body.code).toBe("config_unreadable");

    const repair = await call("POST", "/api/codex-prompt/repair", fx, { confirm: true, revision: get.body.revision });
    expect(repair.status).toBe(409);
    expect(repair.body.code).toBe("config_unreadable");
  });

  test("12b. a hostile Origin is rejected before the route runs", async () => {
    const fx = fixture("");
    // The revision must be VALID. With a stale one this test passes even when
    // origin enforcement is gone: the route runs, returns 409 stale_revision, and
    // a >= 400 assertion is satisfied by the wrong rejection entirely.
    const rev = await revision(fx);
    const url = new URL("http://127.0.0.1:10100/api/codex-prompt/toggle");
    const req = new Request(url, {
      method: "PUT",
      headers: {
        host: "127.0.0.1:10100",
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "apps", enabled: false, revision: rev }),
    });
    const res = await handleManagementAPI(req, url, config, {
      codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath },
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    // The toggle would otherwise have succeeded: this exact request with no
    // Origin header writes the key. That is what makes the rejection meaningful.
    expect(read(fx.configPath)).toBe("");
    const allowed = await call("PUT", "/api/codex-prompt/toggle", fx, { id: "apps", enabled: false, revision: rev });
    expect(allowed.status).toBe(200);
  });

  test("9c. adopt refuses a stale revision", async () => {
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    const res = await call("POST", "/api/codex-prompt/adopt", fx, { confirm: true, revision: "sha256:stale" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("stale_revision");
    expect(existsSync(fx.storePath)).toBe(false);
  });

  test("17c. journal-present is reported by GET, which writes nothing", async () => {
    const fx = fixture(ownedConfig("Be brief."), storeJson([]));
    const journal = fx.storePath.replace(/\.json$/, "") + ".journal";
    writeFileSync(journal, "{}", "utf8");
    const before = read(fx.configPath);
    const res = await call("GET", "/api/codex-prompt", fx);
    expect(res.body.drift).toBe("journal-present");
    expect(read(fx.configPath)).toBe(before);
    expect(read(journal)).toBe("{}");
  });

  test("20d. each write error keeps its exact status, not merely a 4xx", async () => {
    // A range assertion would still pass if unknown_layer silently became a 409.
    const { WRITE_ERROR_STATUS_FOR_TESTS } = await import("../src/server/management/codex-prompt-routes");
    expect(WRITE_ERROR_STATUS_FOR_TESTS).toEqual({
      config_unreadable: 409,
      stale_revision: 409,
      developer_instructions_not_owned: 409,
      unknown_layer: 400,
      store_unreadable: 409,
      invalid_characters: 400,
      write_superseded: 409,
      recovery_required: 409,
      locked: 409,
    });
  });

  test("malformed JSON is a 400, never an empty object", async () => {
    // Swallowing a parse error into {} made an invalid adopt return a successful
    // PREVIEW and an invalid custom return stale_revision.
    const fx = fixture("developer_instructions = \"Answer in Korean.\"\n");
    for (const path of ["/api/codex-prompt/toggle", "/api/codex-prompt/custom"]) {
      const url = new URL("http://127.0.0.1:10100" + path);
      const req = new Request(url, {
        method: "PUT",
        headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
        body: "{not json",
      });
      const res = await handleManagementAPI(req, url, config, {
        codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath },
      });
      expect(res!.status).toBe(400);
    }
    const url = new URL("http://127.0.0.1:10100/api/codex-prompt/adopt");
    const req = new Request(url, {
      method: "POST",
      headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleManagementAPI(req, url, config, {
      codexPromptPaths: { configPath: fx.configPath, storePath: fx.storePath },
    });
    expect(res!.status).toBe(400);
  });

  test("adopt refuses an oversized value, through BOTH import paths", async () => {
    // The owned-malformed repair branch reaches adoptDeveloperInstructions exactly
    // as /adopt does. Without a test on that branch, deleting its cap call is
    // invisible - which is how the bypass got in.
    const big = "z".repeat(64 * 1024 + 10);

    const viaAdopt = fixture("developer_instructions = \"" + big + "\"\n");
    const adopt = await call("POST", "/api/codex-prompt/adopt", viaAdopt, {
      confirm: true, revision: await revision(viaAdopt),
    });
    expect(adopt.status).toBe(400);
    expect(adopt.body.code).toBe("body_too_large");
    expect(existsSync(viaAdopt.storePath)).toBe(false);

    // Marker-adjacent but reshaped: drift is owned-malformed, so repair takes the
    // adopt branch rather than /adopt.
    const viaRepair = fixture(MARKER + "\ndeveloper_instructions  =  \"" + big + "\"\n");
    const get = await call("GET", "/api/codex-prompt", viaRepair);
    expect(get.body.drift).toBe("owned-malformed");
    const repair = await call("POST", "/api/codex-prompt/repair", viaRepair, {
      confirm: true, mode: "adopt", revision: get.body.revision,
    });
    expect(repair.status).toBe(400);
    expect(repair.body.code).toBe("body_too_large");
    expect(existsSync(viaRepair.storePath)).toBe(false);
  });

  test("the composed cap counts existing enabled layers, not the imported body alone", async () => {
    const existing = "y".repeat(70 * 1024);
    const incoming = "z".repeat(60 * 1024);
    const fx = fixture(
      "developer_instructions = \"" + incoming + "\"\n",
      storeJson([{ id: "aaaaaa", title: "Existing", body: existing, enabled: true }]),
    );
    const res = await call("POST", "/api/codex-prompt/adopt", fx, {
      confirm: true, revision: await revision(fx),
    });
    // Each body is under the 64 KiB per-layer cap; together they exceed 128 KiB.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("composed_too_large");
  });

  test("an unrecognized repair mode is refused rather than treated as adopt", async () => {
    const fx = fixture(MARKER + "\ndeveloper_instructions = 'reshaped'\n");
    const res = await call("POST", "/api/codex-prompt/repair", fx, {
      confirm: true, mode: "reset", revision: await revision(fx),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_body");
  });
});
