import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectPaths,
  detectFsType,
  collectProxyEnv,
  probeWham,
} from "../src/doctor";

const TEST_DIR = join(import.meta.dir, ".tmp-doctor-test");
const TEST_CODEX_HOME = join(TEST_DIR, "codex");
const TEST_OPENCODEX_HOME = join(TEST_DIR, "opencodex");
let prevOpencodexHome: string | undefined;
let prevCodexHome: string | undefined;
let prevHttpsProxy: string | undefined;

describe("doctor", () => {
  beforeEach(() => {
    prevOpencodexHome = process.env.OPENCODEX_HOME;
    prevCodexHome = process.env.CODEX_HOME;
    prevHttpsProxy = process.env.HTTPS_PROXY;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_CODEX_HOME, { recursive: true });
    mkdirSync(TEST_OPENCODEX_HOME, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_OPENCODEX_HOME;
    process.env.CODEX_HOME = TEST_CODEX_HOME;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
  });

  afterEach(() => {
    if (prevOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevOpencodexHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevHttpsProxy;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("path report flips auth.json/config.json from absent to present", () => {
    let rows = collectPaths();
    const auth = () => rows.find(r => r.label === "CODEX_HOME/auth.json")!;
    const cfg = () => rows.find(r => r.label === "OPENCODEX_HOME/config.json")!;
    expect(auth().exists).toBe(false);
    expect(cfg().exists).toBe(false);

    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), "{}");
    writeFileSync(join(TEST_OPENCODEX_HOME, "config.json"), "{}");
    rows = collectPaths();
    expect(auth().exists).toBe(true);
    expect(cfg().exists).toBe(true);
  });

  test("detectFsType flags /mnt drvfs mounts and leaves ext4 home alone", () => {
    const mounts = [
      "rootfs / wslroot rw 0 0",
      "/dev/sdc /home ext4 rw,relatime 0 0",
      "drivers /mnt/c drvfs rw,noatime 0 0",
    ].join("\n");

    const c = detectFsType("/mnt/c/Users/test/.opencodex", mounts);
    expect(c.isDrvfs).toBe(true);
    expect(c.isMntDrive).toBe(true);
    expect(c.fstype).toBe("drvfs");

    const home = detectFsType("/home/test/.opencodex", mounts);
    expect(home.isDrvfs).toBe(false);
    expect(home.isMntDrive).toBe(false);
    expect(home.fstype).toBe("ext4");
  });

  test("detectFsType returns n/a when mounts content is unavailable", () => {
    const info = detectFsType("/home/test/.codex", null);
    expect(info.fstype).toBe("n/a");
    expect(info.isDrvfs).toBe(false);
  });

  test("collectProxyEnv reports presence without leaking the value", () => {
    let rows = collectProxyEnv();
    expect(rows.find(r => r.key === "HTTPS_PROXY")!.present).toBe(false);

    process.env.HTTPS_PROXY = "http://user:secret@proxy.example.test:8080";
    rows = collectProxyEnv();
    const https = rows.find(r => r.key === "HTTPS_PROXY")!;
    expect(https.present).toBe(true);
    // The row exposes only a boolean; the secret value is never carried.
    expect(JSON.stringify(rows)).not.toContain("secret");
  });

  test("probeWham classifies ok, http error, timeout, and connect failures", async () => {
    const ok = await probeWham((async () => new Response("{}", { status: 200 })) as typeof fetch);
    expect(ok.ok).toBe(true);
    expect(ok.classification).toBe("ok");
    expect(typeof ok.durationMs).toBe("number");

    const unauth = await probeWham((async () => new Response("", { status: 401 })) as typeof fetch);
    expect(unauth.ok).toBe(false);
    expect(unauth.classification).toBe("http_401");

    const timeout = await probeWham((async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as typeof fetch);
    expect(timeout.classification).toBe("timeout");

    const connect = await probeWham((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(connect.classification).toBe("connect_error");
  });
});
