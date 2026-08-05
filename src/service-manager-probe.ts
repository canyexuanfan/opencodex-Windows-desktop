/**
 * What the service manager says about this machine, read-only and fail-closed.
 *
 * The question this answers is NOT "is a job loaded". Installation writes the
 * definition BEFORE the state file (`service.ts` install paths) and embeds
 * `CODEX_HOME`/`OPENCODEX_HOME` inside it, so an interrupted reinstall leaves a
 * valid state file for one home beside an installed definition for another. A
 * probe that only asked about registration would call that owned. On macOS it is
 * worse: a logged-out user has the plist on disk with no GUI domain at all, so
 * registration reports nothing while a foreign definition sits right there.
 *
 * So the probe reads the DEFINITION, parses the homes out of it, and reports
 * what it saw. Comparing those homes is the caller's job — a probe that returned
 * a verdict would be deciding ownership from half the evidence.
 *
 * Every command here is read-only and bounded. The user's proxy runs under a
 * service manager while this executes; a probe that could start, stop or reload
 * anything is not a probe. An unbounded one is not much better, since a wedged
 * manager would hold the event loop.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Short: this runs inside admission, and a slow answer is the same as none. */
export const SERVICE_PROBE_TIMEOUT_MS = 2_000;

export type ServiceManagerBackend = "launchd" | "systemd" | "scheduler" | "winsw";

export interface ServiceManagerClaim {
  readonly backend: ServiceManagerBackend;
  readonly definitionPath: string;
  /**
   * The homes the definition names. `null` means the definition deliberately
   * omits that key, which is different from naming a different one: an install
   * that ran without `CODEX_HOME` set writes no such key at all.
   */
  readonly homes: {
    readonly codexHome: string | null;
    readonly opencodexHome: string | null;
  };
  readonly registration: "present" | "absent";
}

export type ServiceManagerInstallation =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly claims: readonly ServiceManagerClaim[] }
  | { readonly kind: "conflict"; readonly claims: readonly ServiceManagerClaim[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** Injected so a test can observe the EXACT argv production emits. */
export interface ProbeRunner {
  (file: string, args: readonly string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnFailed: boolean;
  };
}

export const defaultProbeRunner: ProbeRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: SERVICE_PROBE_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    // `signal` is SIGTERM when the timeout fired; a spawn failure sets `error`.
    timedOut: result.signal !== null && result.error === undefined,
    spawnFailed: result.error !== undefined,
  };
};

export interface ProbeDeps {
  readonly run?: ProbeRunner;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly home?: string;
}

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

/**
 * `launchctl print` exits 113 for a service that is not there and 112 when the
 * domain itself cannot be reached — measured against nonexistent targets rather
 * than assumed. Only 113 is an answer; everything else is a failure to ask.
 */
const LAUNCHCTL_NO_SUCH_SERVICE = 113;

function unknown(reason: string): ServiceManagerInstallation {
  return { kind: "unknown", reason };
}

/** Pull `<key>NAME</key><string>VALUE</string>` out of a plist body. */
function plistEnvValue(body: string, key: string): string | null {
  const match = body.match(
    new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`),
  );
  return match ? match[1] : null;
}

/** Pull `Environment="NAME=VALUE"` (quoted or bare) out of a systemd unit. */
function unitEnvValue(body: string, key: string): string | null {
  for (const line of body.split("\n")) {
    const match = line.match(new RegExp(`^\\s*Environment=\\s*"?${key}=([^"\\n]*)"?\\s*$`));
    if (match) return match[1];
  }
  return null;
}

function inspectLaunchd(deps: Required<Pick<ProbeDeps, "run" | "uid" | "home">>): ServiceManagerInstallation {
  const definitionPath = join(deps.home, "Library", "LaunchAgents", `${LABEL}.plist`);

  const printed = deps.run("/bin/launchctl", ["print", `gui/${deps.uid}/${LABEL}`]);
  let registration: "present" | "absent";
  if (printed.spawnFailed || printed.timedOut) {
    return unknown(`launchctl could not be asked: ${printed.timedOut ? "timed out" : printed.stderr.trim()}`);
  }
  if (printed.status === 0) registration = "present";
  else if (printed.status === LAUNCHCTL_NO_SUCH_SERVICE) registration = "absent";
  else return unknown(`launchctl print exited ${String(printed.status)}: ${printed.stderr.trim()}`);

  if (!existsSync(definitionPath)) {
    // No file. A registration without one means launchd holds a definition whose
    // file is gone — real, and not something to resolve unattended.
    return registration === "absent"
      ? { kind: "absent" }
      : unknown("launchd has a job loaded but its plist is missing");
  }

  let body: string;
  try {
    body = readFileSync(definitionPath, "utf-8");
  } catch (error) {
    // Present-but-unreadable cannot supply homes, and `present` without homes
    // would compare equal to nothing and read as agreement.
    return unknown(`the launchd plist exists but could not be read: ${String(error)}`);
  }

  return {
    kind: "present",
    claims: [{
      backend: "launchd",
      definitionPath,
      homes: {
        codexHome: plistEnvValue(body, "CODEX_HOME"),
        opencodexHome: plistEnvValue(body, "OPENCODEX_HOME"),
      },
      registration,
    }],
  };
}

function systemdProperty(out: string, key: string): string | null {
  for (const line of out.split("\n")) {
    const match = line.match(new RegExp(`^${key}=(.*)$`));
    if (match) return match[1].trim();
  }
  return null;
}

function inspectSystemd(deps: Required<Pick<ProbeDeps, "run" | "home">>): ServiceManagerInstallation {
  const definitionPath = join(deps.home, ".config", "systemd", "user", `${TASK}.service`);

  /*
   * All four properties in one call. LoadState alone is not enough — it is
   * orthogonal to ActiveState — and neither says whether the LOADED bytes match
   * the file. NeedDaemonReload is that signal, and this repository already
   * documents it as the systemd analogue of launchd's stale plist.
   */
  const shown = deps.run("systemctl", [
    "--user", "show", TASK,
    "-p", "LoadState", "-p", "ActiveState", "-p", "FragmentPath", "-p", "NeedDaemonReload",
  ]);
  if (shown.spawnFailed || shown.timedOut) {
    return unknown(`systemctl could not be asked: ${shown.timedOut ? "timed out" : shown.stderr.trim()}`);
  }
  if (shown.status !== 0) {
    // A missing unit still exits ZERO and says not-found; a non-zero status means
    // the question never reached the bus.
    return unknown(`systemctl show exited ${String(shown.status)}: ${shown.stderr.trim()}`);
  }

  const loadState = systemdProperty(shown.stdout, "LoadState");
  const activeState = systemdProperty(shown.stdout, "ActiveState");
  const fragmentPath = systemdProperty(shown.stdout, "FragmentPath");
  const needReload = systemdProperty(shown.stdout, "NeedDaemonReload");
  if (loadState === null || activeState === null || needReload === null) {
    return unknown("systemctl show did not report the properties it was asked for");
  }
  if (needReload === "yes") {
    return unknown("systemd has a stale definition loaded; it needs daemon-reload");
  }

  const registration: "present" | "absent" =
    loadState === "not-found" && activeState === "inactive" && !fragmentPath ? "absent" : "present";

  if (!existsSync(definitionPath)) {
    return registration === "absent"
      ? { kind: "absent" }
      : unknown("systemd knows this unit but its file is missing");
  }

  let body: string;
  try {
    body = readFileSync(definitionPath, "utf-8");
  } catch (error) {
    return unknown(`the systemd unit exists but could not be read: ${String(error)}`);
  }

  return {
    kind: "present",
    claims: [{
      backend: "systemd",
      definitionPath,
      homes: {
        codexHome: unitEnvValue(body, "CODEX_HOME"),
        opencodexHome: unitEnvValue(body, "OPENCODEX_HOME"),
      },
      registration,
    }],
  };
}

/**
 * Windows is deferred to its own phase and reports `unknown` until then.
 *
 * Not an oversight: the definition there is a chain, not a file. The task XML
 * names only the launcher, and the homes live in the batch wrapper it eventually
 * runs — a probe that parsed the XML and stopped would find no homes and read
 * that as agreement. Reporting `unknown` refuses unattended convergence on
 * Windows, which is the safe direction while the chain walk is unwritten.
 */
function inspectWindows(): ServiceManagerInstallation {
  return unknown("the Windows definition chain is not inspected yet");
}

export function inspectServiceManagerInstallation(deps: ProbeDeps = {}): ServiceManagerInstallation {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultProbeRunner;
  const home = deps.home ?? homedir();
  if (platform === "darwin") return inspectLaunchd({ run, uid: deps.uid ?? process.getuid?.() ?? 0, home });
  if (platform === "linux") return inspectSystemd({ run, home });
  if (platform === "win32") return inspectWindows();
  return unknown(`no service manager probe for platform ${platform}`);
}
