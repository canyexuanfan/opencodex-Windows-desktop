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
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveTrustedWindowsSchtasksExe } from "./lib/windows-elevation";
import { statusWinswRaw, WINSW_SERVICE_ID } from "./lib/winsw";

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

/**
 * Windows probe runner: preserves schtasks stdout/stderr as raw bytes so the
 * UTF-16LE task XML is not corrupted by a UTF-8 decode.
 */
export type RawProbeRunner = (file: string, args: readonly string[]) => {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  spawnFailed: boolean;
};

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

export const defaultRawProbeRunner: RawProbeRunner = (file, args) => {
  const result = spawnSync(file, [...args], {
    encoding: "buffer",
    windowsHide: true,
    timeout: SERVICE_PROBE_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    timedOut: result.signal !== null && result.error === undefined,
    spawnFailed: result.error !== undefined,
  };
};

export interface ProbeDeps {
  readonly run?: ProbeRunner;
  /** Raw-buffer runner for Windows tasks (UTF-16LE output). Defaults to defaultRawProbeRunner. */
  readonly runRaw?: RawProbeRunner;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly home?: string;
  /** Effective OpenCodex config dir (OPENCODEX_HOME). Overrides `<home>/.opencodex`. */
  readonly configDir?: string;
  /** Injectable WinSW SCM status check (defaults to statusWinswRaw). */
  readonly winswStatus?: () => "started" | "stopped" | "nonexistent" | "unknown";
}

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

/**
 * `launchctl print` exits 113 for a service that is not there and 112 when the
 * domain itself cannot be reached — measured against nonexistent targets rather
 * than assumed. Only 113 is an answer; everything else is a failure to ask.
 */
const LAUNCHCTL_NO_SUCH_SERVICE = 113;
/**
 * 112 is an answer about the DOMAIN, not the label.
 *
 * Measured on macOS 27.0: querying a domain with no service name at all still
 * returns it, and a domain that does not exist cannot be running one of our
 * jobs. Treating it as "could not ask" would refuse every write on a fresh
 * headless Mac — no GUI domain, and no installation either.
 */
const LAUNCHCTL_NO_SUCH_DOMAIN = 112;

/**
 * Residue on disk, distinguished from a path that could not be read.
 *
 * `existsSync` answers "no" for a dangling symlink and for a path whose parent
 * denies traversal. Both are residue, not absence — only ENOENT is absence.
 */
function artifactPresence(path: string): "present" | "absent" | "unreadable" {
  try {
    lstatSync(path);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable";
  }
}

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

  /*
   * BOTH domains, because they are independent and hold separate service sets.
   * Measured on macOS 27.0: the shipped agent answers 0 under `gui/<uid>` and
   * 113 under `user/<uid>`. Asking only one leaves the other free to hold a job
   * this probe would then call absent.
   */
  let registration: "present" | "absent" = "absent";
  let unreachableDomains = 0;
  for (const domain of [`gui/${deps.uid}`, `user/${deps.uid}`]) {
    const printed = deps.run("/bin/launchctl", ["print", `${domain}/${LABEL}`]);
    if (printed.spawnFailed || printed.timedOut) {
      return unknown(`launchctl could not be asked: ${printed.timedOut ? "timed out" : printed.stderr.trim()}`);
    }
    if (printed.status === 0) { registration = "present"; break; }
    if (printed.status === LAUNCHCTL_NO_SUCH_SERVICE) continue;
    if (printed.status === LAUNCHCTL_NO_SUCH_DOMAIN) { unreachableDomains += 1; continue; }
    return unknown(`launchctl print exited ${String(printed.status)}: ${printed.stderr.trim()}`);
  }

  const definition = artifactPresence(definitionPath);
  if (definition === "absent") {
    // No file. A registration without one means launchd holds a definition whose
    // file is gone — real, and not something to resolve unattended.
    if (registration === "present") {
      return unknown("launchd has a job loaded but its plist is missing");
    }
    /*
     * Nothing staged, and every domain either answered "no such service" or does
     * not exist. 112 is an answer ABOUT THE DOMAIN and is label-independent —
     * querying a domain with no service name at all returns it — so an
     * unreachable domain cannot be hiding a job of ours. Calling this `unknown`
     * instead would refuse every write on a fresh headless Mac, which has no
     * GUI domain and no installation either.
     */
    void unreachableDomains;
    return { kind: "absent" };
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

  if (artifactPresence(definitionPath) === "absent") {
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
 * Windows: walk the scheduled-task definition chain and report the homes it names.
 *
 * The chain is not one file: the task XML names only the launcher, the launcher
 * (VBS) names only the batch wrapper, and the homes live in the wrapper's
 * `set "CODEX_HOME=..."` / `set "OPENCODEX_HOME=..."` lines. Parsing the XML
 * and stopping would find no homes and read that as agreement, so the walk goes
 * all the way to the wrapper.
 *
 * A `set` line is OMITTED by `buildWindowsServiceScript` when the value was
 * unset at install time (windowsBatchSet returns null for empty values), so a
 * missing home stays `null` — the same contract the launchd/systemd probes use —
 * and a definition that names no homes cannot be mistaken for agreement.
 *
 * Registration is answered by one bounded `schtasks /query /xml` call so a
 * definition staged on disk but never registered is still visible (the
 * interrupted-install case). Every failure to ask is `unknown`, never absence.
 */
function windowsTaskName(): string {
  return "opencodex-proxy";
}

function windowsConfigDirPath(deps: { home: string; configDir?: string }): string {
  // The wrapper assets live under the effective OPENCODEX_HOME (service.ts
  // writes them via getConfigDir()). A customized OPENCODEX_HOME must be
  // honored, not shadowed by the default-home mirror.
  if (deps.configDir) return deps.configDir;
  return join(deps.home, ".opencodex");
}

/** Decode an on-disk Windows text asset (task XML, VBS), which is UTF-16LE (often BOM-prefixed). */
function decodeWindowsText(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  const bomUtf16Le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const bomUtf16Be = buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff;
  const looksUtf16Le = buffer.length >= 4
    && buffer[1] === 0x00
    && buffer[3] === 0x00
    && buffer[0] !== 0x00;
  if (bomUtf16Le || looksUtf16Le) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "").trim();
  }
  if (bomUtf16Be) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1]!;
      swapped[i - 1] = buffer[i]!;
    }
    return swapped.toString("utf16le").trim();
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
}

/** Pull the launcher path out of the task XML `<Arguments>` element. */
function windowsTaskArguments(xml: string): string | null {
  const match = /<Arguments[^>]*>\s*([^<]*?)\s*<\/Arguments>/i.exec(xml);
  if (!match) return null;
  // The registered document escapes `"` as `&quot;`; decode before extracting
  // the quoted path so the same regex sees both the on-disk and /query forms.
  const raw = match[1]!.trim()
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'");
  return raw;
}

/**
 * Pull the wrapper path out of a VBS `shell.Run` line.
 *
 * `buildWindowsLauncherVbs` escapes a `"` inside a VBS string literal by
 * doubling it, so a wrapper `C:\...\opencodex-service.cmd` is emitted as
 * `shell.Run """C:\...\opencodex-service.cmd""", 0, True`. Matching the
 * whole doubled-quote span — `"""` ... `"""` — is the only form that
 * survives both a plain quoted path and one with spaces.
 */
function vbsWrappedCommand(body: string): string | null {
  const match = /\.Run\s+"""([^"]*)"""/.exec(body);
  if (match) {
    const unwrapped = match[1]!.trim();
    if (unwrapped.length > 0) return unwrapped;
  }
  const plain = /\.Run\s+"([^"]+)"/.exec(body);
  return plain ? plain[1]!.trim() : null;
}

/** Pull one `set "NAME=value"` out of a batch wrapper. */
function batchSetValue(body: string, name: string): string | null {
  const match = new RegExp(`^\\s*set\\s+"${name}=([^"]*)"\\s*$`, "im").exec(body);
  return match ? match[1]!.trim() : null;
}

/**
 * Resolve a home value the way cmd would, reversing what
 * `windowsEnvIndirectBatchValue` + `windowsBatchValue` baked in.
 *
 * The builder rewrites a home under USERPROFILE/APPDATA/LOCALAPPDATA to a
 * `%VAR%` token (so non-ASCII profile names survive the OEM-codepage parse),
 * and doubles literal `%` as `%%` so the token itself survives the escaping.
 * A probe that returned that batch syntax verbatim would compare it against
 * the resolved current home and report a false disagreement. Expand known
 * tokens via the live environment, then un-double any remaining `%%`.
 */
function decodeBatchPathValue(
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  // Sentinel that cannot appear in a decoded path; %-escapes are restored after
  // token expansion so `%%USERPROFILE%%` stays a literal `%USERPROFILE%`.
  const escapedPercent = "\u0000";
  const tokens: Record<string, string | undefined> = {
    USERPROFILE: env.USERPROFILE,
    APPDATA: env.APPDATA,
    LOCALAPPDATA: env.LOCALAPPDATA,
    SYSTEMROOT: env.SystemRoot,
  };
  return value
    .replace(/%%/g, escapedPercent)
    .replace(/%([A-Za-z][A-Za-z0-9_]*)%/g, (whole, name: string) => {
      // cmd.exe variable names are case-insensitive; treat a defined empty
      // value as resolved (expand to empty) rather than unresolved.
      const resolved = tokens[name.toUpperCase()];
      return resolved === undefined ? whole : resolved;
    })
    .replaceAll(escapedPercent, "%");
}

/**
 * True when the wrapper looks like one `buildWindowsServiceScript` generated:
 * a `:loop` label followed by the line-anchored `%OCX_BUN%` / `%OCX_CLI%`
 * invocation that launches `start`. Absent `set` lines are only meaningful
 * evidence of "deliberately omitted" when the wrapper is otherwise the
 * generated artifact — an empty, truncated, or unrelated readable file must
 * not read as a legitimate install that omitted both homes.
 */
function wrapperLooksGenerated(body: string): boolean {
  return /:loop\s*[\s\S]*^"%OCX_BUN%" "%OCX_CLI%" start\b[^\r\n]*$/im.test(body);
}

/**
 * The one stderr text that proves `schtasks /query /tn ...` answered "no such
 * task". schtasks exits 1 for both "task not found" and "access denied"; only
 * the message distinguishes them, so absence is keyed on the message, never on
 * the exit code alone.
 */
const SCHTASKS_TASK_NOT_FOUND = /cannot find the file specified/i;

/**
 * Registration state of the scheduled task.
 *
 * `present` is exit 0. `absent` is ONLY a nonzero exit whose stderr states the
 * task cannot be found. Everything else — access denied, other execution
 * errors, signal termination, null status, spawn/timeout failures, any other
 * nonzero exit — is `unknown`, because none of those prove the task is not
 * there. Treating them as absence would let a locked-down or wedged Task
 * Scheduler read as a clean machine.
 */
function probeWindowsTaskRegistration(deps: Required<Pick<ProbeDeps, "runRaw">>): {
  registered: "present" | "absent" | "unknown";
  registeredXml: string;
} {
  // Resolve schtasks through the trusted System32 helper so a planted binary on
  // PATH cannot be executed from an attacker-controlled project directory. If
  // the trusted resolver itself fails, fail closed — never fall back to PATH.
  let schtasks: string;
  try {
    schtasks = resolveTrustedWindowsSchtasksExe();
  } catch {
    return { registered: "unknown", registeredXml: "" };
  }
  const queried = deps.runRaw(schtasks, ["/query", "/tn", windowsTaskName(), "/xml"]);
  if (queried.spawnFailed || queried.timedOut) return { registered: "unknown", registeredXml: "" };
  if (queried.status === 0) {
    // The registered document is UTF-16LE; decode the RAW bytes (decoding as
    // UTF-8 first would corrupt the XML).
    const registeredXml = decodeWindowsText(queried.stdout) || decodeWindowsText(queried.stderr);
    return { registered: "present", registeredXml };
  }
  const text = `${decodeWindowsText(queried.stdout)}\n${decodeWindowsText(queried.stderr)}`;
  if (queried.status !== null && SCHTASKS_TASK_NOT_FOUND.test(text)) {
    return { registered: "absent", registeredXml: "" };
  }
  return { registered: "unknown", registeredXml: "" };
}

function inspectWindows(deps: Required<Pick<ProbeDeps, "runRaw" | "home">> & Pick<ProbeDeps, "configDir" | "winswStatus">): ServiceManagerInstallation {
  const configDir = windowsConfigDirPath(deps);
  const taskXmlPath = join(configDir, "opencodex-service-task.xml");
  const task = artifactPresence(taskXmlPath);

  // The native WinSW backend is a separate SCM registration. If it exists, it
  // is authoritative on its own; if BOTH the scheduler task and WinSW are
  // present that is a conflict (an interrupted backend switch). Only a claim
  // whose registration is "present" counts as installed.
  const winsw = walkWinswChain(deps);
  const winswInstalled = winsw.kind === "present" && winsw.claims[0].registration === "present";

  let xml = "";
  if (task !== "absent") {
    try {
      xml = decodeWindowsText(readFileSync(taskXmlPath));
    } catch (error) {
      return unknown(`the scheduled-task XML exists but could not be read: ${String(error)}`);
    }
  }

  const registration = probeWindowsTaskRegistration(deps);
  if (registration.registered === "unknown") {
    return unknown("Task Scheduler could not be asked whether opencodex-proxy is registered");
  }

  const schedulerPresent = task !== "absent" && registration.registered !== "absent";
  if (winswInstalled && schedulerPresent) {
    // Walk the staged scheduler definition first so the conflict carries its
    // real homes instead of null placeholders.
    const staged = walkWindowsChain(deps, xml, taskXmlPath);
    const stagedClaim = staged.kind === "present" ? staged.claims[0] : null;
    return {
      kind: "conflict",
      claims: [
        winsw.claims[0],
        stagedClaim ?? { backend: "scheduler", definitionPath: taskXmlPath, homes: { codexHome: null, opencodexHome: null }, registration: "present" },
      ],
    };
  }
  if (winswInstalled) return winsw;

  // WinSW exists but its SCM state cannot be verified, and a scheduler task is
  // also present: neither backend can be ruled out, so fail closed.
  if (winsw.kind === "unknown" && task !== "absent") {
    return unknown("cannot confirm native WinSW status alongside the scheduled task");
  }
  if (winsw.kind === "unknown" && task === "absent" && registration.registered === "absent") {
    return winsw;
  }

  if (task === "absent") {
    return registration.registered === "present"
      ? unknown("Task Scheduler holds opencodex-proxy but its task XML is missing")
      : { kind: "absent" };
  }

  const staged = walkWindowsChain(deps, xml, taskXmlPath);
  if (staged.kind !== "present") return staged;
  const stagedClaim = staged.claims[0];

  // A registered task whose chain disagrees with the staged one is an
  // interrupted reinstall — Task Scheduler will launch the OLD wrapper while
  // the staging copy claims new homes. Any failure to walk the registered
  // definition is also unknown (it cannot be trusted).
  if (registration.registered === "present" && registration.registeredXml.trim()) {
    const registeredWalk = walkWindowsChain(deps, registration.registeredXml, taskXmlPath);
    if (registeredWalk.kind !== "present") return registeredWalk;
    const registeredClaim = registeredWalk.claims[0];
    const homesDisagree = !homesEqual(registeredClaim.homes, stagedClaim.homes);
    if (homesDisagree) {
      return unknown("the registered scheduled task names different homes than the staged task definition");
    }
  }

  return {
    kind: "present",
    claims: [{
      ...stagedClaim,
      registration: registration.registered === "present" ? "present" : "absent",
    }],
  };
}

/** Compare two home pairs with Windows path normalization (case, slashes, trailing separators). */
function homesEqual(a: { codexHome: string | null; opencodexHome: string | null }, b: { codexHome: string | null; opencodexHome: string | null }): boolean {
  const norm = (v: string | null): string | null => {
    if (v === null) return null;
    return v.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
  };
  return norm(a.codexHome) === norm(b.codexHome) && norm(a.opencodexHome) === norm(b.opencodexHome);
}

/**
 * Walk one scheduled-task definition (staged or registered XML) down to the
 * batch wrapper and extract the homes it names. Returns `absent` only when the
 * XML is absent; every broken or malformed link is `unknown`.
 */
function walkWindowsChain(
  deps: Required<Pick<ProbeDeps, "home">> & Pick<ProbeDeps, "configDir">,
  xml: string,
  definitionPath: string,
): ServiceManagerInstallation {
  const launcherArg = windowsTaskArguments(xml);
  if (!launcherArg) {
    return unknown("the scheduled-task XML names no launcher to run");
  }
  // The <Arguments> element is `/b /nologo "C:\...\opencodex-service-launcher.vbs"`.
  const launcherPath = /"([^"]+)"/.exec(launcherArg)?.[1];
  if (!launcherPath) {
    return unknown("the scheduled-task XML launcher argument is not a quoted path");
  }
  const launcher = artifactPresence(launcherPath);
  if (launcher === "absent") {
    return unknown(`the scheduled-task launcher is missing: ${launcherPath}`);
  }
  let launcherBody: string;
  try {
    launcherBody = decodeWindowsText(readFileSync(launcherPath));
  } catch (error) {
    return unknown(`the scheduled-task launcher could not be read: ${String(error)}`);
  }
  const wrapperPath = vbsWrappedCommand(launcherBody);
  if (!wrapperPath) {
    return unknown(`the launcher ${launcherPath} names no wrapper to run`);
  }
  const wrapper = artifactPresence(wrapperPath);
  if (wrapper === "absent") {
    return unknown(`the launcher wrapper is missing: ${wrapperPath}`);
  }
  let wrapperBody: string;
  try {
    wrapperBody = decodeWindowsText(readFileSync(wrapperPath));
  } catch (error) {
    return unknown(`the launcher wrapper could not be read: ${String(error)}`);
  }

  /*
   * A wrapper that does not look generated is not evidence of deliberate
   * omission — it is malformed. An empty or truncated wrapper, or an unrelated
   * readable file, must fail closed rather than read as "no homes baked".
   */
  if (!wrapperLooksGenerated(wrapperBody)) {
    return unknown(`the launcher wrapper does not look like a generated opencodex service wrapper: ${wrapperPath}`);
  }

  const rawCodexHome = batchSetValue(wrapperBody, "CODEX_HOME");
  const rawOpencodexHome = batchSetValue(wrapperBody, "OPENCODEX_HOME");

  return {
    kind: "present",
    claims: [{
      backend: "scheduler",
      definitionPath,
      homes: {
        codexHome: rawCodexHome === null ? null : decodeBatchPathValue(rawCodexHome),
        opencodexHome: rawOpencodexHome === null ? null : decodeBatchPathValue(rawOpencodexHome),
      },
      registration: "absent",
    }],
  };
}

/**
 * Walk the WinSW native-backend definition (its XML embeds the homes as
 * `<env name="CODEX_HOME" .../>` / `OPENCODEX_HOME`). Returns `present` when
 * the SCM registration exists; `absent` when the XML is gone and the SCM
 * confirms no registration; `unknown` on any failure to ask.
 */
function walkWinswChain(deps: Required<Pick<ProbeDeps, "home">> & Pick<ProbeDeps, "configDir" | "winswStatus">): ServiceManagerInstallation {
  const configDir = windowsConfigDirPath(deps);
  // WinSW assets live under the effective OPENCODEX_HOME (winswDir() resolves
  // via getConfigDir()); honor the injected configDir for tests and custom homes.
  const exePath = join(configDir, "winsw", `${WINSW_SERVICE_ID}.exe`);
  const xmlPath = join(configDir, "winsw", `${WINSW_SERVICE_ID}.xml`);
  const xml = artifactPresence(xmlPath);
  const status = (deps.winswStatus ?? statusWinswRaw)();

  if (xml === "absent" && status === "nonexistent") return { kind: "absent" };
  if (xml === "absent" || status === "unknown") {
    return unknown("the native WinSW service registration could not be verified");
  }
  let body: string;
  try {
    body = decodeWindowsText(readFileSync(xmlPath));
  } catch (error) {
    return unknown(`the WinSW XML could not be read: ${String(error)}`);
  }
  // The generated WinSW XML carries the expected launch structure; a malformed
  // or unrelated XML must fail closed like the scheduler wrapper check.
  if (!winswXmlLooksGenerated(body)) {
    return unknown(`the WinSW XML does not look like a generated opencodex service definition: ${xmlPath}`);
  }
  const envValue = (name: string): string | null => {
    // Match an <env> element with the target name in EITHER attribute order,
    // single- or double-quoted, and pull its value attribute.
    const tag = new RegExp(`<env\\b[^>]*\\bname=["']${name}["'][^>]*>`, "i").exec(body)
      ?? new RegExp(`<env\\b[^>]*>[^<]*`, "i").exec(body);
    if (!tag) return null;
    const value = /value=(["'])(.*?)\1/i.exec(tag[0]);
    return value ? value[2] : null;
  };
  return {
    kind: "present",
    claims: [{
      backend: "winsw",
      definitionPath: exePath,
      homes: {
        codexHome: envValue("CODEX_HOME"),
        opencodexHome: envValue("OPENCODEX_HOME"),
      },
      registration: status === "started" || status === "stopped" ? "present" : "absent",
    }],
  };
}

/**
 * The generated WinSW XML embeds the SCM id and a `start --port` invocation in
 * `<arguments>`; anything else is malformed, not a deliberate omission.
 */
function winswXmlLooksGenerated(body: string): boolean {
  return /<id>\s*opencodex-proxy-native\s*<\/id>/i.test(body)
    && /<arguments>.*?start\s+--port\b/i.test(body);
}

export function inspectServiceManagerInstallation(deps: ProbeDeps = {}): ServiceManagerInstallation {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultProbeRunner;
  const runRaw = deps.runRaw ?? defaultRawProbeRunner;
  const home = deps.home ?? homedir();
  if (platform === "darwin") return inspectLaunchd({ run, uid: deps.uid ?? process.getuid?.() ?? 0, home });
  if (platform === "linux") return inspectSystemd({ run, home });
  if (platform === "win32") return inspectWindows({ runRaw, home, configDir: deps.configDir, winswStatus: deps.winswStatus });
  return unknown(`no service manager probe for platform ${platform}`);
}
