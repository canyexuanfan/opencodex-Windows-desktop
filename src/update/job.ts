import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, getConfigDir, loadConfig, readPid, readRuntimePort } from "../config";
import { killProxy } from "../lib/process-control";
import { waitForPortAvailable } from "../server/ports";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { isServiceInstalled } from "../service";
import {
  type Channel,
  type Installer,
  PKG,
  checkUpdatePackageIntegrity,
  currentVersion,
  defaultUpdateTag,
  detectInstall,
  latestVersion,
  updateCommand,
  updateCommandStr,
} from "./index";
import { isNewer } from "./notify";

const RELEASE_NOTES_URL = "https://github.com/lidge-jun/opencodex/releases/latest";
const UPDATE_JOB_FILENAME = "update-job.json";
const UPDATE_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const RESTART_HEALTH_TIMEOUT_MS = 15_000;
const RESTART_STABILITY_WINDOW_MS = 15_000;

export type UpdateJobStatus = "running" | "restarting" | "succeeded" | "failed";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  updateAvailable: boolean;
  canUpdate: boolean;
  command: string;
  releaseNotesUrl: string;
  reason?: string;
}

export interface UpdateJobState {
  id: string;
  status: UpdateJobStatus;
  startedAt: string;
  updatedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: Installer;
  restart: boolean;
  command: string;
  releaseNotesUrl: string;
  log: string[];
  pid?: number;
  error?: string;
  exitCode?: number | null;
  signal?: string | null;
  restarted?: boolean;
}

export class UpdateJobError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "update_error") {
    super(message);
  }
}

export interface UpdateCheckDeps {
  currentVersion: () => string;
  detectInstall: () => Installer;
  latestVersion: (tag: Channel) => string | null;
}

const defaultCheckDeps: UpdateCheckDeps = {
  currentVersion,
  detectInstall,
  latestVersion,
};

function nodeBin(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function packageLauncherPath(): string {
  // This module lives at src/update/job.ts — the launcher is <pkg-root>/bin/ocx.mjs.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ocx.mjs");
}

function formatCommand(bin: string, args: string[]): string {
  return `${bin} ${args.join(" ")}`;
}

function manualSourceCommand(): string {
  return "git pull && bun install && bun run build:gui";
}

export function normalizeUpdateChannel(raw: string | null | undefined, current = currentVersion()): Channel {
  return raw === "latest" || raw === "preview" ? raw : defaultUpdateTag(current);
}

export function updateJobPath(): string {
  return join(getConfigDir(), UPDATE_JOB_FILENAME);
}

function ensureJobDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJob(job: UpdateJobState): void {
  ensureJobDir();
  atomicWriteFile(updateJobPath(), `${JSON.stringify(job, null, 2)}\n`);
}

export function readUpdateJob(jobId?: string | null): UpdateJobState | null {
  try {
    const parsed = JSON.parse(readFileSync(updateJobPath(), "utf8")) as UpdateJobState;
    if (jobId && parsed.id !== jobId) return null;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.status !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function updateJob(job: UpdateJobState, patch: Partial<UpdateJobState>, logLine?: string): UpdateJobState {
  const current = readUpdateJob(job.id) ?? job;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    log: logLine ? [...current.log, logLine] : current.log,
  };
  writeJob(next);
  return next;
}

export function updateExecutionCommand(
  installer: Installer,
  channel: Channel,
  launcher = packageLauncherPath(),
  resolvedVersion?: string | null,
): { bin: string; args: string[]; display: string } {
  if (installer === "npm") {
    const bin = nodeBin();
    const args = [launcher, "update", "--tag", channel];
    // The Node launcher self-update re-resolves the tag at its own time — a residual
    // divergence window this path cannot close (documented, not claimed immutable).
    return { bin, args, display: formatCommand(bin, args) };
  }
  if (installer === "bun") {
    const { bin, args } = updateCommand(installer, channel, resolvedVersion);
    return { bin, args, display: updateCommandStr(installer, channel, resolvedVersion) };
  }
  return { bin: "sh", args: ["-lc", manualSourceCommand()], display: manualSourceCommand() };
}

export function restartCommand(
  serviceInstalled: boolean,
  installer: Installer,
  launcher = packageLauncherPath(),
  port?: number,
  serviceArgs?: string[],
): { mode: "service" | "proxy"; bin: string; args: string[]; display: string } {
  const mode = serviceInstalled ? "service" : "proxy";
  const pinPort = !serviceInstalled && typeof port === "number" && Number.isFinite(port) && port > 0;
  const startArgs = pinPort
    ? [launcher, "start", "--port", String(Math.trunc(port))]
    : [launcher, "start"];
  const svcArgs = serviceInstalled ? [launcher, ...(serviceArgs ?? ["service", "install"])] : startArgs;
  if (installer === "npm") {
    const bin = nodeBin();
    const args = svcArgs;
    return { mode, bin, args, display: formatCommand(bin, args) };
  }
  // bun/source installs: restart via the current runtime executable + package launcher (both real
  // .exe files), NOT the `ocx.cmd` shim. Spawning a `.cmd` shell-less throws EINVAL on Windows
  // Node/Bun ≥18.20/20.12 (CVE-2024-27980 hardening) — the same class the npm path (nodeBin) avoids.
  const bin = process.execPath;
  const args = svcArgs;
  return { mode, bin, args, display: formatCommand(bin, args) };
}

export function checkForUpdate(
  requestedChannel?: Channel,
  deps: UpdateCheckDeps = defaultCheckDeps,
): UpdateCheckResult {
  const current = deps.currentVersion();
  const installer = deps.detectInstall();
  const channel = requestedChannel ?? normalizeUpdateChannel(null, current);
  const latest = installer === "source" ? null : deps.latestVersion(channel);
  const updateAvailable = !!latest && isNewer(latest, current, channel);
  let reason: string | undefined;
  let command = installer === "source" ? manualSourceCommand() : updateExecutionCommand(installer, channel).display;

  if (installer === "source") {
    reason = "source_checkout";
    command = manualSourceCommand();
  } else if (!latest) {
    reason = "latest_unavailable";
  } else if (!updateAvailable) {
    reason = "already_latest";
  }

  return {
    currentVersion: current,
    latestVersion: latest,
    channel,
    installer,
    updateAvailable,
    canUpdate: installer !== "source" && updateAvailable,
    command,
    releaseNotesUrl: RELEASE_NOTES_URL,
    ...(reason ? { reason } : {}),
  };
}

function newJobId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function startUpdateJob(channel: Channel, restart: boolean): UpdateJobState {
  const running = readUpdateJob();
  if (running?.status === "running" || running?.status === "restarting") {
    throw new UpdateJobError("An update job is already running", 409, "update_already_running");
  }

  const check = checkForUpdate(channel);
  if (!check.canUpdate) {
    throw new UpdateJobError(check.reason ?? "No update is available", 409, check.reason ?? "update_unavailable");
  }

  const id = newJobId();
  const now = new Date().toISOString();
  const job: UpdateJobState = {
    id,
    status: "running",
    startedAt: now,
    updatedAt: now,
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    channel: check.channel,
    installer: check.installer,
    restart,
    command: check.command,
    releaseNotesUrl: check.releaseNotesUrl,
    log: [`Update job queued for ${check.currentVersion} -> ${check.latestVersion}.`],
  };
  writeJob(job);

  const child = spawn(process.execPath, [process.argv[1], "__gui-update-worker", id, channel, restart ? "restart" : "no-restart"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();
  return { ...job, pid: child.pid };
}

function runLoggedCommand(job: UpdateJobState, bin: string, args: string[], timeout: number): { status: number | null; signal: NodeJS.Signals | null } {
  job = updateJob(job, {}, `$ ${formatCommand(bin, args)}`);
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (stdout) job = updateJob(job, {}, stdout.slice(-4000));
  if (stderr) updateJob(job, {}, stderr.slice(-4000));
  return { status: result.status, signal: result.signal };
}

function spawnDetachedStart(job: UpdateJobState, installer: Installer, port?: number): void {
  const cmd = restartCommand(false, installer, packageLauncherPath(), port);
  const env = { ...process.env };
  delete env.OCX_SERVICE;
  updateJob(job, {}, `$ ${cmd.display}`);
  const child = spawn(cmd.bin, cmd.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
}

/** Test seam: the wait/spawn pair is injectable so the restart path is verifiable. */
export interface RestartIo {
  waitForPort?: typeof waitForPortAvailable;
  spawnStart?: (job: UpdateJobState, installer: Installer, port?: number) => void;
  serviceInstalledFn?: () => boolean;
  probeProxy?: (port: number, hostname?: string) => Promise<boolean>;
  sleepMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Service-mode install/reinstall command (defaults to spawnSync via runLoggedCommand). */
  runService?: (
    job: UpdateJobState,
    bin: string,
    args: string[],
  ) => { status: number | null; signal?: NodeJS.Signals | null };
}

async function restartAfterUpdate(
  job: UpdateJobState,
  captured?: { port: number; hostname: string },
  io: RestartIo = {},
): Promise<void> {
  const serviceInstalled = (io.serviceInstalledFn ?? isServiceInstalled)();
  const config = loadConfig();
  // The stop-first update flow has already cleared pid/runtime state by the time we run,
  // so the pre-update capture (taken before the update command) is the authoritative
  // port to wait on; config is only the cold-start fallback.
  const port = captured?.port ?? config.port ?? 10100;
  const hostname = captured?.hostname ?? config.hostname ?? "127.0.0.1";
  let svcArgs: string[] | undefined;
  if (serviceInstalled) {
    try {
      const { serviceReinstallArgs } = await import("../service");
      svcArgs = serviceReinstallArgs();
    } catch { /* fallback to default service install */ }
  }
  const cmd = restartCommand(serviceInstalled, job.installer, packageLauncherPath(), port, svcArgs);
  const waitFn = io.waitForPort ?? waitForPortAvailable;

  if (serviceInstalled) {
    // Stop-first update already unloaded the service; wait for the socket to drain,
    // then reinstall wrappers that bake `--port` via OCX_BAKE_PORT (PR #152 gap).
    const freed = await waitFn(port, hostname, { timeoutMs: 5_000, intervalMs: 25 });
    if (!freed) {
      updateJob(job, {}, `Port ${port} still busy after stop; reinstalling service with pinned --port ${port} anyway.`);
    }
    const prevBake = process.env.OCX_BAKE_PORT;
    process.env.OCX_BAKE_PORT = String(Math.trunc(port));
    let serviceOk = false;
    try {
      const run = io.runService ?? ((j, bin, args) => runLoggedCommand(j, bin, args, RESTART_TIMEOUT_MS));
      const result = run(job, cmd.bin, cmd.args);
      serviceOk = result.status === 0;
      if (!serviceOk) {
        // On Windows, `schtasks /create` requires an elevated token. The update worker
        // inherits the (non-admin) proxy's privileges, so a service-managed install
        // updated from the GUI or a normal terminal fails here with access denied.
        // Falling back to a direct proxy start keeps the update from leaving the proxy
        // stopped; the stale service manager can be refreshed later with an admin
        // `ocx service install`.
        updateJob(job, {}, `Service reinstall failed (exit ${result.status ?? "?"}); falling back to a direct proxy start. Run 'ocx service install' as administrator to refresh the background service manager.`);
      }
    } finally {
      if (prevBake === undefined) delete process.env.OCX_BAKE_PORT;
      else process.env.OCX_BAKE_PORT = prevBake;
    }
    if (serviceOk) return;
    // Fall through to the direct proxy start below so the update never leaves the
    // proxy stopped when the service reinstall could not run.
  }

  const pid = readPid();
  if (pid) {
    updateJob(job, {}, `Stopping current proxy PID ${pid}.`);
    killProxy(pid);
  }
  // The old socket can stay busy briefly after stop (Windows taskkill drain, or the
  // stop-first update path that already killed the proxy before we got here) — wait
  // unconditionally on the captured port so the pinned start does not race the drain.
  const freed = await waitFn(port, hostname, { timeoutMs: 2_000, intervalMs: 25 });
  if (!freed) {
    updateJob(job, {}, `Port ${port} still busy after stop; starting with --port ${port} anyway.`);
  }
  (io.spawnStart ?? spawnDetachedStart)(job, job.installer, port);
}

/** Exposed for tests: drives the non-service restart path with injected io. */
export function restartAfterUpdateForTests(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo,
): Promise<void> {
  return restartAfterUpdate(job, captured, io);
}

function restartFailureHint(port: number): string {
  return `Update installed, but the restarted proxy did not stay healthy on port ${port}. `
    + "Try 'ocx start'. If the update log shows bun postinstall or EPERM warnings, "
    + "reinstall with 'npm install -g --allow-scripts=bun @bitkyc08/opencodex'.";
}

/**
 * Confirm that the detached/service restart really came back and stayed up. The GUI worker
 * used to mark success immediately after spawning the new process, which hid Windows cases
 * where npm left the bundled Bun runtime half-updated and the restarted proxy died seconds
 * later. A healthy /healthz must appear, then remain healthy for one short stability window.
 */
async function confirmRestartedProxy(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo = {},
): Promise<boolean> {
  /* [Decision Log]
  - 목적과 의도: GUI update job이 detached restart 요청만 보고 성공 처리하지 않도록, 실제 프록시 복귀 여부를 확인한다.
  - 기존 구현 및 제약 조건: update-job.json은 spawn/service reinstall 직후 `succeeded`로 끝났고, Windows npm/Bun 교체 실패처럼 몇 초 후 죽는 재시작을 잡지 못했다.
  - 검토한 주요 대안: (1) 포트 점유만 확인 — 외부 프로세스/죽기 직전 프로세스를 성공으로 오인할 수 있다. (2) 무기한 /healthz 폴링 — UX가 느려지고 worker 종료 시점이 불명확하다. (3) 짧은 healthy 등장 + 안정성 창 확인 — 실제 복귀를 확인하면서도 대기 시간을 제한할 수 있다.
  - 선택한 방식: identity-aware /healthz probe가 일정 시간 안에 나타나고, 추가 안정성 창 동안 유지되는지 확인한다.
  - 다른 대안 대신 이 방식을 선택한 이유: GUI는 "업데이트가 설치됐지만 재시작은 실패"를 분리해 알려줘야 하며, 이 방식이 가장 적은 오탐으로 그 경계를 만든다.
  - 장점, 단점 및 영향: 장점은 silent restart failure가 update-job 상태로 드러난다는 점이다. 단점은 성공 판정이 최대 30초 늦어질 수 있다는 점이며, 대신 실제 복귀를 더 정확히 반영한다.
  */
  const probe = io.probeProxy ?? (async (port: number, hostname?: string) => (
    !!(await proxyIdentityAt(port, { hostname }))
  ));
  const sleep = io.sleepMs ?? (async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
  const now = io.now ?? (() => Date.now());
  const port = captured.port;
  const hostname = captured.hostname;
  const startDeadline = now() + RESTART_HEALTH_TIMEOUT_MS;

  while (now() < startDeadline) {
    if (await probe(port, hostname)) {
      updateJob(job, {}, `Proxy reported healthy on ${hostname}:${port}; confirming it stays up...`);
      const stableUntil = now() + RESTART_STABILITY_WINDOW_MS;
      while (now() < stableUntil) {
        if (!(await probe(port, hostname))) {
          updateJob(job, {
            status: "failed",
            restarted: false,
            error: `proxy restart became unhealthy on ${hostname}:${port}`,
          }, restartFailureHint(port));
          return false;
        }
        await sleep(500);
      }
      updateJob(job, {}, `Proxy stayed healthy for ${Math.trunc(RESTART_STABILITY_WINDOW_MS / 1000)}s after restart.`);
      return true;
    }
    await sleep(250);
  }

  updateJob(job, {
    status: "failed",
    restarted: false,
    error: `proxy restart never became healthy on ${hostname}:${port}`,
  }, restartFailureHint(port));
  return false;
}

export function confirmRestartAfterUpdateForTests(
  job: UpdateJobState,
  captured: { port: number; hostname: string },
  io: RestartIo,
): Promise<boolean> {
  return confirmRestartedProxy(job, captured, io);
}

export async function runGuiUpdateWorker(jobId: string, channel: Channel, restart: boolean): Promise<void> {
  let job = readUpdateJob(jobId);
  const check = checkForUpdate(channel);
  const now = new Date().toISOString();
  // Capture the live listen target BEFORE the update command runs: the stop-first update
  // flow clears pid/runtime state, so this is the last moment the real port is knowable.
  // Only trust runtime-port.json when its pid matches the live pidfile process.
  const rt = readRuntimePort();
  const livePid = readPid();
  const preUpdateConfig = loadConfig();
  const runtimeTrusted = !!(rt && livePid && rt.pid === livePid);
  const configPort = typeof preUpdateConfig.port === "number" && preUpdateConfig.port > 0
    ? preUpdateConfig.port
    : 10100;
  const captured = {
    port: runtimeTrusted ? rt.port : configPort,
    hostname: (runtimeTrusted ? rt.hostname : undefined) ?? preUpdateConfig.hostname ?? "127.0.0.1",
  };
  if (!job) {
    job = {
      id: jobId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      channel: check.channel,
      installer: check.installer,
      restart,
      command: check.command,
      releaseNotesUrl: check.releaseNotesUrl,
      log: [],
    };
    writeJob(job);
  }

  try {
    if (!check.canUpdate) {
      throw new Error(check.reason ?? "No update is available");
    }

    // Pre-flight integrity metadata check (same lanes as the CLI): anomalous registry
    // metadata for a resolved version fails the job BEFORE anything is spawned or the
    // proxy is stopped; transient registry failure degrades to a logged skip.
    const integrity = checkUpdatePackageIntegrity(check.latestVersion);
    if (integrity.ok === false) {
      updateJob(job, { status: "failed", error: integrity.reason });
      return;
    }
    const integrityLine = integrity.ok === "skipped"
      ? `Integrity pre-flight skipped: ${integrity.reason}. Proceeding best-effort.`
      : `Verified ${PKG}@${check.latestVersion} integrity metadata ${integrity.integrity.slice(0, 24)}…`;

    const cmd = updateExecutionCommand(check.installer, channel, undefined, check.latestVersion);
    job = updateJob(job, {
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      installer: check.installer,
      command: cmd.display,
    }, integrityLine);

    /* [Decision Log]
    - 목적: GUI 요청 처리 프로세스가 자신이 실행 중인 패키지를 직접 덮어쓰지 않도록 업데이트를 별도 worker에서 수행한다.
    - 대안 분석: (1) 서버에서 runUpdate 직접 호출: process.exit/stdio/실행 파일 교체 위험. (2) GUI에서 CLI 명령 안내만 제공: 자동 업데이트 UX 부족. (3) 숨은 worker가 Node launcher/Bun 전역 명령을 실행: 상태 추적과 안전한 재시작이 가능.
    - 선택 근거: 현재 CLI의 npm self-update 우회를 재사용하면서도 GUI 서버 요청 생명주기와 설치 작업을 분리할 수 있어 가장 안정적이다.
    */
    const result = runLoggedCommand(job, cmd.bin, cmd.args, UPDATE_TIMEOUT_MS);
    if (result.status !== 0) {
      updateJob(job, {
        status: "failed",
        exitCode: result.status,
        signal: result.signal,
        error: `update command failed (${result.status ?? "?"})`,
      });
      return;
    }

    if (restart) {
      job = updateJob(job, { status: "restarting" }, "Update installed. Restarting proxy...");
      await restartAfterUpdate(job, captured);
      if (!(await confirmRestartedProxy(job, captured))) return;
      updateJob(job, { status: "succeeded", restarted: true }, "Restart requested and proxy is healthy.");
      return;
    }

    updateJob(job, { status: "succeeded", restarted: false }, "Update installed. Restart the proxy to use the new version.");
  } catch (err) {
    updateJob(job, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
