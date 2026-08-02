import { isAbsolute } from "node:path";
import { apiError, apiJson, proxyUnreachable, resolveBaseUrl, type AccountDeps } from "./account-api";

const USAGE = `Usage:
  ocx account main doctor [--json]
  ocx account main list [--json]
  ocx account main register <label> [--json]
  ocx account main add <label>
  ocx account main switch <profile-id-or-label> --yes [--json]
  ocx account main recover [--rollback --yes] [--json]

Native main login profiles change the physical Codex App/CLI login in the effective CODEX_HOME.
They are independent from the OpenCodex Pool selected by 'ocx account use openai'.`;

interface PublicProfile {
  id: string;
  label: string;
  identityHint: string;
  state: "active" | "inactive";
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function reject(args: string[]): number {
  if (args.length > 0) console.error(`Unexpected argument(s): ${args.join(", ")}`);
  console.error(USAGE);
  return 1;
}

function printProfiles(profiles: PublicProfile[]): void {
  if (profiles.length === 0) { console.log("No native main login profiles registered."); return; }
  const rows = profiles.map(profile => [profile.state === "active" ? "*" : " ", profile.label, profile.id, profile.identityHint]);
  const header = ["", "LABEL", "PROFILE ID", "IDENTITY"];
  const widths = header.map((value, index) => Math.max(value.length, ...rows.map(row => row[index]!.length)));
  const line = (columns: string[]) => columns.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  console.log([line(header), ...rows.map(line)].join("\n"));
}

async function runOfficialCodexLogin(codexHome: string): Promise<number> {
  const child = Bun.spawn(["codex", "login"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

export async function cmdNativeMainAccount(args: string[], deps: AccountDeps): Promise<number> {
  const sub = args.shift();
  const wantsJson = flag(args, "--json");
  const confirmed = flag(args, "--yes");
  const rollback = flag(args, "--rollback");
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  if (sub === "doctor" || sub === "list") {
    if (args.length > 0 || confirmed || rollback) return reject(args);
    const path = sub === "doctor" ? "/api/native-main-profiles/doctor" : "/api/native-main-profiles";
    const result = await apiJson(deps, baseUrl, "GET", path);
    if (result.status === 0) return proxyUnreachable();
    if (result.status !== 200) return apiError(result.json, `failed to ${sub} native profiles`);
    if (wantsJson || sub === "doctor") console.log(JSON.stringify(result.json, null, 2));
    else printProfiles(Array.isArray(result.json.profiles) ? result.json.profiles as PublicProfile[] : []);
    return 0;
  }

  if (sub === "register") {
    const label = args.shift();
    if (!label || args.length > 0 || confirmed || rollback) return reject(args);
    const result = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/register", { label });
    if (result.status === 0) return proxyUnreachable();
    if (result.status !== 200) return apiError(result.json, "failed to register the current native login");
    if (wantsJson) console.log(JSON.stringify(result.json, null, 2));
    else console.log(`Registered '${label}' for ${String(result.json.effectiveCodexHome ?? "the effective CODEX_HOME")}.`);
    return 0;
  }

  if (sub === "add") {
    const label = args.shift();
    if (!label || args.length > 0 || wantsJson || confirmed || rollback) return reject(args);
    const stage = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/stage", {});
    if (stage.status === 0) return proxyUnreachable();
    if (stage.status !== 200) return apiError(stage.json, "failed to prepare native login staging");
    const stageId = typeof stage.json.stageId === "string" ? stage.json.stageId : "";
    const stagingHome = typeof stage.json.stagingCodexHome === "string" ? stage.json.stagingCodexHome : "";
    if (!stageId || !isAbsolute(stagingHome)) {
      console.error("Error: the proxy returned an invalid staging session.");
      return 1;
    }
    let exitCode = 1;
    try {
      console.error(`Starting official Codex login in restricted staging home: ${stagingHome}`);
      exitCode = await (deps.runCodexLoginImpl ?? runOfficialCodexLogin)(stagingHome);
      if (exitCode !== 0) throw new Error("Official Codex login did not complete successfully.");
      const finish = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/stage/finish", { stageId, label });
      if (finish.status === 0) return proxyUnreachable();
      if (finish.status !== 200) return apiError(finish.json, "failed to encrypt the staged native login");
      console.log(`Added encrypted native profile '${label}'.`);
      return 0;
    } catch (error) {
      await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/stage/cancel", { stageId });
      console.error(`Error: ${error instanceof Error ? error.message : "Official Codex login failed."}`);
      return exitCode === 0 ? 1 : exitCode;
    }
  }

  if (sub === "switch") {
    const target = args.shift();
    if (!target || args.length > 0 || rollback || !confirmed) {
      if (!confirmed) console.error("Close Codex App/CLI, then pass --yes to confirm it is stopped.");
      return reject(args);
    }
    const result = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/switch", { target, confirmedStopped: true });
    if (result.status === 0) return proxyUnreachable();
    if (result.status !== 200) return apiError(result.json, "failed to switch the native login");
    if (wantsJson) console.log(JSON.stringify(result.json, null, 2));
    else {
      const profile = result.json.activeProfile as PublicProfile | undefined;
      console.log(`Native Codex login is now '${profile?.label ?? target}'. Restart Codex App/CLI before continuing.`);
    }
    return 0;
  }

  if (sub === "recover") {
    if (args.length > 0 || (rollback && !confirmed)) {
      if (rollback && !confirmed) console.error("--rollback changes the native login and requires --yes.");
      return reject(args);
    }
    const result = await apiJson(deps, baseUrl, "POST", "/api/native-main-profiles/recover", rollback
      ? { rollback: true, confirmedStopped: true }
      : { rollback: false });
    if (result.status === 0) return proxyUnreachable();
    if (result.status !== 200) return apiError(result.json, "failed to recover the native-profile transaction");
    if (wantsJson) console.log(JSON.stringify(result.json, null, 2));
    else console.log(result.json.recovered === true ? `Recovery completed: ${String(result.json.action ?? "converged")}.` : "No recovery journal is pending.");
    return 0;
  }

  return reject(args);
}
