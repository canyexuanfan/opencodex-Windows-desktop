import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { scanEvidence } from "./openai-hardening-evidence-scan";

export interface GateSpec {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface GateResult {
  exitCode: number;
  output: string;
}

export interface GateDeps {
  run: (gate: GateSpec) => Promise<GateResult>;
  writeSummary: (text: string) => void;
  scan: () => string[];
}

function summaryLine(index: number, gate: GateSpec, result: GateResult): string {
  const pass = /(?:^|\n)\s*(\d+) pass\b/m.exec(result.output)?.[1] ?? "na";
  const fail = /(?:^|\n)\s*(\d+) fail\b/m.exec(result.output)?.[1] ?? "na";
  const build = /(?:built in|build completed|build complete)/i.test(result.output) ? "pass" : "na";
  return `command[${index}]=${gate.name}|exit=${result.exitCode}|pass=${pass}|fail=${fail}|build=${build}`;
}

export async function runGateSequence(plan: GateSpec[], deps: GateDeps): Promise<string> {
  const lines = ["schemaVersion=1", "verdict=PASS"];
  for (const [index, gate] of plan.entries()) {
    const result = await deps.run(gate);
    if (result.exitCode !== 0) throw new Error(`gate failed: ${gate.name} (${result.exitCode})`);
    lines.push(summaryLine(index, gate, result));
  }
  const summary = lines.join("\n") + "\n";
  deps.writeSummary(summary);
  const findings = deps.scan();
  if (findings.length) throw new Error(`evidence scan failed: ${findings.join(", ")}`);
  return summary;
}

const cycle020 = [
  "tests/openai-provider-tiers.test.ts", "tests/openai-provider-tier-migration.test.ts", "tests/openai-tier-startup.test.ts",
  "tests/provider-registry-parity.test.ts", "tests/router.test.ts", "tests/codex-catalog.test.ts",
  "tests/codex-auth-context.test.ts", "tests/codex-routing.test.ts", "tests/codex-main-rotation.test.ts",
  "tests/codex-websocket-registry.test.ts", "tests/codex-quota-prime.test.ts", "tests/provider-quota.test.ts",
  "tests/server-auth.test.ts", "tests/server-search.test.ts", "tests/server-images.test.ts",
  "tests/web-search-anthropic.test.ts", "tests/vision-anthropic.test.ts", "tests/sidecar-abort.test.ts",
  "tests/web-search.test.ts", "tests/web-search-timeout-plan.test.ts", "tests/claude-sidecar-override.test.ts",
  "tests/e2e-style/phase100-native-parity.test.ts", "tests/vision-cache.test.ts", "tests/oauth-public-surface.test.ts",
  "tests/chatgpt-oauth.test.ts", "tests/oauth-login-summary.test.ts",
];
const cycle030040 = [
  "tests/openai-api-virtual-models.test.ts", "tests/config.test.ts", "tests/provider-registry-parity.test.ts",
  "tests/umans-provider.test.ts", "tests/codex-catalog.test.ts", "tests/request-log.test.ts",
  "tests/usage-log.test.ts", "tests/usage-summary.test.ts", "tests/provider-payload.test.ts",
  "tests/codex-multi-state.test.ts", "tests/openai-hardening-tooling.test.ts",
];

export function finalGatePlan(root: string, evidenceDir: string, unitRoot = dirname(evidenceDir)): GateSpec[] {
  const env = { ...process.env, OCX_EVIDENCE_DIR: evidenceDir } as Record<string, string>;
  const unitPath = relative(root, unitRoot);
  return [
    { name: "openai-three-tier-e2e", command: ["bun", "test", "tests/openai-three-tier-e2e.test.ts"], cwd: root, env },
    { name: "cycle-020-focused", command: ["bun", "test", ...cycle020], cwd: root },
    { name: "cycle-030-040-tooling", command: ["bun", "test", ...cycle030040], cwd: root },
    { name: "isolated-runtime-smoke", command: ["bun", "scripts/openai-three-tier-runtime-smoke.ts", "--evidence-dir", evidenceDir], cwd: root },
    { name: "live-key-status", command: ["bun", "scripts/openai-three-tier-runtime-smoke.ts", "--check-live-key", "--evidence-dir", evidenceDir], cwd: root },
    { name: "typescript", command: ["bun", "x", "tsc", "--noEmit"], cwd: root },
    { name: "full-isolated-tests", command: ["bun", "test", "--isolate", "tests"], cwd: root },
    { name: "privacy-scan", command: ["bun", "run", "privacy:scan"], cwd: root },
    { name: "gui-i18n", command: ["bun", "run", "lint:i18n"], cwd: join(root, "gui") },
    { name: "gui-build", command: ["bun", "run", "build"], cwd: join(root, "gui") },
    { name: "docs-install", command: ["bun", "install", "--frozen-lockfile"], cwd: join(root, "docs-site") },
    { name: "docs-build", command: ["bun", "run", "build"], cwd: join(root, "docs-site") },
    {
      name: "scoped-diff-check",
      command: ["git", "diff", "--check", "--", "README.md", "README.ko.md", "README.zh-CN.md", "structure",
        "docs-site/src/content/docs", "devlog/_chase/_model", "tests/openai-three-tier-e2e.test.ts",
        "tests/openai-hardening-tooling.test.ts", "tests/fixtures/openai-three-tier-migration-child.ts",
        "scripts/openai-three-tier-runtime-child.ts", "scripts/openai-three-tier-runtime-smoke.ts",
        "scripts/openai-hardening-evidence-scan.ts", "scripts/openai-hardening-final-gates.ts",
        "scripts/openai-hardening-live-policy.ts", "scripts/openai-hardening-runtime-env.ts",
        "src/server/request-log.ts", "src/codex/catalog.ts",
        join(unitPath, "050_integration_verification.md"),
        join(unitPath, "190_consolidated_finish_plan.md")],
      cwd: root,
    },
  ];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const argValue = (name: string): string | undefined => {
    const index = Bun.argv.indexOf(name);
    return index >= 0 ? Bun.argv[index + 1] : undefined;
  };
  const evidenceArg = argValue("--evidence-dir");
  const unitArg = argValue("--unit-root");
  const evidencePath = evidenceArg ? resolve(root, evidenceArg) : undefined;
  const unitCandidates = [
    "devlog/_plan/260717_openai_hardening",
    "devlog/_fin/260717_openai_hardening",
  ].map(path => resolve(root, path));
  const unitRoot = unitArg
    ? resolve(root, unitArg)
    : evidencePath
      ? dirname(evidencePath)
      : unitCandidates.find(existsSync) ?? unitCandidates[0]!;
  const evidenceDir = evidencePath ?? join(unitRoot, "evidence");
  const summaryPath = join(evidenceDir, "050_gate_summary.txt");
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const paths = ["050_e2e.json", "050_client_history.json", "050_runtime_smoke.json", "050_gate_summary.txt"].map(name => join(evidenceDir, name));
  const run = async (gate: GateSpec): Promise<GateResult> => {
    process.stdout.write(`[gate] ${gate.name}\n`);
    const child = Bun.spawn(gate.command, {
      cwd: gate.cwd,
      env: gate.env ? { ...process.env, ...gate.env } : process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}\n${stderr}`;
    process.stdout.write(`[gate] ${gate.name} exit=${exitCode}\n`);
    return { exitCode, output: output.slice(-500_000) };
  };
  const writeSummary = (text: string) => {
    const temp = `${summaryPath}.tmp-${process.pid}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, summaryPath);
  };
  await runGateSequence(finalGatePlan(root, evidenceDir, unitRoot), {
    run,
    writeSummary,
    scan: () => scanEvidence(paths),
  });
  console.log("OpenAI hardening final gates passed");
}
