/**
 * The service-manager probe, and the ownership it feeds.
 *
 * Three ways this could pass while broken, each named by an audit and each
 * answered here rather than by care:
 *   - inspect only the disk definition and miss a stale LOADED one
 *   - report `present` for a definition whose homes could not be parsed
 *   - mutation-test the fixture's argv instead of the argv production emits
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectServiceManagerInstallation,
  type ProbeRunner,
} from "../src/service-manager-probe";
import { inspectNativeCodexOwnership } from "../src/integrations/native/ownership-preflight";

let home = "";
const cleanup: string[] = [];
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

/** Records exactly what production asked for, so the allowlist is observed. */
function recorder(reply: (file: string, args: readonly string[]) => Partial<ReturnType<ProbeRunner>>) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const run: ProbeRunner = (file, args) => {
    calls.push({ file, args });
    return { status: 0, stdout: "", stderr: "", timedOut: false, spawnFailed: false, ...reply(file, args) };
  };
  return { run, calls };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-probe-"));
  cleanup.push(home);
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
});
afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function writePlist(codexHome: string | null, opencodexHome: string | null): string {
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "com.opencodex.proxy.plist");
  writeFileSync(path, [
    "<plist><dict><key>EnvironmentVariables</key><dict>",
    codexHome ? `<key>CODEX_HOME</key><string>${codexHome}</string>` : "",
    opencodexHome ? `<key>OPENCODEX_HOME</key><string>${opencodexHome}</string>` : "",
    "</dict></dict></plist>",
  ].join("\n"));
  return path;
}

function writeUnit(codexHome: string, opencodexHome: string): string {
  const dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencodex-proxy.service");
  writeFileSync(path, [
    "[Service]",
    `Environment="CODEX_HOME=${codexHome}"`,
    `Environment="OPENCODEX_HOME=${opencodexHome}"`,
  ].join("\n"));
  return path;
}

describe("the probe only ever asks", () => {
  /**
   * The user's proxy is live under a service manager while this runs. A probe
   * that could start, stop or reload anything is not a probe — and asserting
   * that from the source text is not enough, because this unit has already
   * shipped a fix that was only a comment.
   */
  test("macOS asks launchctl exactly once, with print", () => {
    const { run, calls } = recorder(() => ({ status: 113 }));
    inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("/bin/launchctl");
    expect(calls[0].args[0]).toBe("print");
    for (const verb of ["load", "unload", "bootstrap", "bootout", "kickstart", "start", "stop", "enable", "disable"]) {
      expect(calls[0].args).not.toContain(verb);
    }
  });

  test("Linux asks systemctl exactly once, with show", () => {
    const { run, calls } = recorder(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n",
    }));
    inspectServiceManagerInstallation({ run, platform: "linux", home });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("systemctl");
    expect(calls[0].args).toContain("show");
    expect(calls[0].args).toContain("--user");
    for (const verb of ["start", "stop", "restart", "reload", "daemon-reload", "enable", "disable", "kill"]) {
      expect(calls[0].args).not.toContain(verb);
    }
  });

  test("and it asks systemd for the stale-definition signal, not just the load state", () => {
    const { run, calls } = recorder(() => ({
      stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n",
    }));
    inspectServiceManagerInstallation({ run, platform: "linux", home });
    // LoadState alone cannot say whether the LOADED bytes match the file.
    expect(calls[0].args).toContain("NeedDaemonReload");
  });
});

describe("absence has to be proven twice", () => {
  test("no registration and no definition is absent", () => {
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }))
      .toEqual({ kind: "absent" });
  });

  /**
   * The case a registration-only probe gets wrong: a logged-out macOS user has
   * the plist on disk with no GUI domain, so nothing is loaded while a foreign
   * definition sits right there.
   */
  test("no registration but a definition on disk is NOT absent", () => {
    const path = writePlist("/somewhere/.codex", "/somewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });

    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].registration).toBe("absent");
    expect(result.claims[0].definitionPath).toBe(path);
    expect(result.claims[0].homes).toEqual({ codexHome: "/somewhere/.codex", opencodexHome: "/somewhere/.opencodex" });
  });

  test("a registration with no definition file is unknown, not present", () => {
    const { run } = recorder(() => ({ status: 0, stdout: "state = running" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("unknown");
  });
});

describe("could not ask is not an answer", () => {
  /**
   * Measured against real nonexistent targets: 113 is "no such service", 112 is
   * "no such domain". Only the first is an answer.
   */
  test("exit 112 (no GUI domain) is unknown, not absent", () => {
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("unknown");
  });

  test("a launchctl timeout is unknown", () => {
    const { run } = recorder(() => ({ status: null, timedOut: true }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }).kind).toBe("unknown");
  });

  /**
   * systemd does NOT signal absence through the exit code — a missing unit
   * prints not-found and exits ZERO. A non-zero status means the question never
   * reached the bus, which is the opposite conclusion.
   */
  test("a non-zero systemctl status is unknown even though a missing unit exits zero", () => {
    const { run } = recorder(() => ({ status: 1, stderr: "Failed to connect to bus" }));
    expect(inspectServiceManagerInstallation({ run, platform: "linux", home }).kind).toBe("unknown");
  });

  test("NeedDaemonReload=yes is unknown — systemd is running something else", () => {
    writeUnit("/x/.codex", "/x/.opencodex");
    const { run } = recorder(() => ({
      stdout: "LoadState=loaded\nActiveState=active\nFragmentPath=/x/unit\nNeedDaemonReload=yes\n",
    }));
    const result = inspectServiceManagerInstallation({ run, platform: "linux", home });
    expect(result.kind).toBe("unknown");
    expect(result.kind === "unknown" && result.reason).toContain("daemon-reload");
  });

  test("Windows refuses rather than guessing at a chain it does not walk", () => {
    // The task XML names only the launcher; the homes are in the batch wrapper.
    // Parsing the XML and stopping would find no homes and read that as
    // agreement, so until the chain walk exists the honest answer is unknown.
    expect(inspectServiceManagerInstallation({ platform: "win32", home }).kind).toBe("unknown");
  });
});

describe("a definition that cannot supply homes is not present", () => {
  test("an unreadable plist is unknown", () => {
    const dir = join(home, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    // A directory where the plist should be: exists, cannot be read as a file.
    mkdirSync(join(dir, "com.opencodex.proxy.plist"));
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home }).kind).toBe("unknown");
  });

  /**
   * An omitted key is not a disagreement: an install run without CODEX_HOME set
   * writes no such key at all, and `null` has to survive to the caller so the
   * comparison can skip it rather than compare against "".
   */
  test("an omitted home is null, not an empty string", () => {
    writePlist(null, "/somewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectServiceManagerInstallation({ run, platform: "darwin", uid: 501, home });
    expect(result.kind).toBe("present");
    if (result.kind !== "present") return;
    expect(result.claims[0].homes.codexHome).toBeNull();
    expect(result.claims[0].homes.opencodexHome).toBe("/somewhere/.opencodex");
  });
});

describe("ownership refuses what it cannot prove", () => {
  /*
   * The default state paths include the DEFAULT home mirror, resolved from
   * homedir(), which no test sandbox moves. Left alone, these fixtures would
   * read the developer's real installation and call their own machine foreign.
   */
  function own(extra: { run: ProbeRunner }) {
    const codexHome = join(home, ".codex");
    const opencodexHome = join(home, ".opencodex");
    return {
      ...extra,
      platform: "darwin" as const,
      uid: 501,
      home,
      statePaths: [join(opencodexHome, "service-state.json")],
      currentHomes: { codexHome, opencodexHome },
    };
  }

  function useHomes(): { codexHome: string; opencodexHome: string } {
    const codexHome = join(home, ".codex");
    const opencodexHome = join(home, ".opencodex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(opencodexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    process.env.OPENCODEX_HOME = opencodexHome;
    return { codexHome, opencodexHome };
  }

  function writeState(dir: string, codexHome: string, opencodexHome: string): void {
    writeFileSync(join(dir, "service-state.json"), JSON.stringify({
      version: 2, codexHome, opencodexHome, backend: "scheduler",
    }));
  }

  test("a fresh home with no state and no service is owned", () => {
    useHomes();
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  test("state naming another home is foreign", () => {
    const { opencodexHome } = useHomes();
    writeState(opencodexHome, "/elsewhere/.codex", "/elsewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("foreign");
  });

  /*
   * THE interrupted reinstall. Installation writes the definition BEFORE the
   * state file, so a valid state for this home can sit beside a plist naming
   * another. Picking a winner unattended means guessing which half of a
   * half-finished operation to believe.
   */
  test("state says here, definition says elsewhere — unknown, not owned", () => {
    const { codexHome, opencodexHome } = useHomes();
    writeState(opencodexHome, codexHome, opencodexHome);
    writePlist("/elsewhere/.codex", "/elsewhere/.opencodex");
    const { run } = recorder(() => ({ status: 113 }));

    const result = inspectNativeCodexOwnership(own({ run }));
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("different homes");
  });

  test("state and definition agreeing is owned", () => {
    const { codexHome, opencodexHome } = useHomes();
    writeState(opencodexHome, codexHome, opencodexHome);
    writePlist(codexHome, opencodexHome);
    const { run } = recorder(() => ({ status: 113 }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("owned");
  });

  test("an installed definition that no state file accounts for is unknown", () => {
    const { codexHome, opencodexHome } = useHomes();
    writePlist(codexHome, opencodexHome);
    const { run } = recorder(() => ({ status: 0, stdout: "state = running" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("unknown");
  });

  /*
   * The fail-open helper this replaces returns {ok:true} here, which is right
   * for a teardown route a human just invoked and wrong as authority for an
   * unattended write.
   */
  test("a malformed state file is unknown, where the teardown helper says fine", () => {
    const { opencodexHome } = useHomes();
    writeFileSync(join(opencodexHome, "service-state.json"), "{ not json");
    const { run } = recorder(() => ({ status: 113 }));
    const result = inspectNativeCodexOwnership(own({ run }));
    expect(result.ownership).toBe("unknown");
    expect(result.reason).toContain("malformed");
  });

  test("an unaskable service manager is unknown even with clean state", () => {
    const { codexHome, opencodexHome } = useHomes();
    writeState(opencodexHome, codexHome, opencodexHome);
    const { run } = recorder(() => ({ status: 112, stderr: "Could not find domain for user" }));
    expect(inspectNativeCodexOwnership(own({ run })).ownership).toBe("unknown");
  });
});
