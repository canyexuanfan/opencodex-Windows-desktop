import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDenyFindings, scanEvidence } from "../scripts/openai-hardening-evidence-scan";
import { runGateSequence, type GateResult, type GateSpec } from "../scripts/openai-hardening-final-gates";
import { evaluateLivePolicy, type LiveOutcome } from "../scripts/openai-hardening-live-policy";
import { buildSanitizedRuntimeEnv } from "../scripts/openai-hardening-runtime-env";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function validArtifacts(): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "ocx-evidence-tooling-"));
  roots.push(root);
  writeJson(join(root, "050_e2e.json"), {
    schemaVersion: 1,
    verdict: "PASS",
    publicNetworkFallback: false,
    httpCases: 6,
    websocketTurns: 4,
    compactCases: 4,
    canonicalUrls: ["https://api.openai.com/v1/responses"],
    migrationRestore: "PASS",
    virtualIdentity: "PASS",
    reverseInsertionOrder: "PASS",
    realClaudeStateUnchanged: true,
  });
  writeJson(join(root, "050_client_history.json"), {
    schemaVersion: 1,
    verdict: "PASS",
    selectedModel: "openai-apikey/gpt-5.6-sol-pro",
    modelProvider: "openai",
    resolvedModel: "gpt-5.6-sol",
    reasoningMode: "pro",
    rolloutCount: 1,
    attempts: 1,
  });
  writeJson(join(root, "050_runtime_smoke.json"), {
    schemaVersion: 1,
    verdict: "PASS",
    instances: [{ pid: 101, version: "test", port: 45001 }, { pid: 102, version: "test", port: 45002 }],
    distinctPids: true,
    catalogReady: true,
    direct: { model: "gpt-5.6-sol", credentialOwner: "openai-direct-caller", accountOwner: null },
    multi: { model: "gpt-5.6-terra", credentialOwner: "openai-multi-main", accountOwner: "main" },
    apiPro: { model: "gpt-5.6-sol", reasoningMode: "pro", credentialOwner: "openai-apikey" },
    clientHistoryVerified: true,
    codexVersion: "test",
    userState: { "opencodex-config": { exists: false, sha256: null } },
    liveKey: { status: "NOT RUN (credential unavailable)", liveCalls: 0, outcomes: [] },
  });
  writeFileSync(join(root, "050_gate_summary.txt"), "schemaVersion=1\nverdict=PASS\ncommand[0]=tests|exit=0|pass=3|fail=0|build=na\n");
  return {
    root,
    paths: ["050_e2e.json", "050_client_history.json", "050_runtime_smoke.json", "050_gate_summary.txt"]
      .map(name => join(root, name)),
  };
}

function liveOutcome(selectedId: string, status = 200, resolvedId = "gpt-5.6-sol"): LiveOutcome {
  return { status, requestId: null, selectedId, resolvedId };
}

describe("OpenAI hardening evidence scanner", () => {
  test("accepts the four strict artifacts and an optional PASS audit", () => {
    const fixture = validArtifacts();
    expect(scanEvidence(fixture.paths)).toEqual([]);
    const audit = join(fixture.root, "051_audit_wp050_implementation.md");
    writeFileSync(audit, "VERDICT: PASS\n");
    expect(scanEvidence([...fixture.paths, audit])).toEqual([]);
  });

  test("detects every denied evidence class", () => {
    const rows: Array<[string, string]> = [
      ["absolute-home", "/Users/test/private"],
      ["email", "owner@example.test"],
      ["bearer", "Bearer bad"],
      ["api-key", "sk-abcdefghijkl"],
      ["jwt", "eyJa.eyJb.sig"],
      ["prompt", "Reply exactly"],
      ["fixture-secret", "fixture-refresh-token"],
    ];
    for (const [kind, value] of rows) expect(evidenceDenyFindings(value)).toContain(kind);
  });

  test("rejects missing, empty, unknown-key, missing-tri-state, and bad audits", () => {
    const missing = validArtifacts();
    rmSync(missing.paths[0]!);
    expect(scanEvidence(missing.paths).some(error => error.includes("missing"))).toBe(true);

    const empty = validArtifacts();
    writeFileSync(empty.paths[1]!, "");
    expect(scanEvidence(empty.paths).some(error => error.includes("empty"))).toBe(true);

    const unknown = validArtifacts();
    const e2e = JSON.parse(readFileSync(unknown.paths[0]!, "utf8")) as Record<string, unknown>;
    e2e.unexpected = true;
    writeJson(unknown.paths[0]!, e2e);
    expect(scanEvidence(unknown.paths).some(error => error.includes("unknown or missing keys"))).toBe(true);

    const triState = validArtifacts();
    const runtime = JSON.parse(readFileSync(triState.paths[2]!, "utf8")) as Record<string, unknown>;
    delete runtime.liveKey;
    writeJson(triState.paths[2]!, runtime);
    expect(scanEvidence(triState.paths).some(error => error.includes("unknown or missing keys"))).toBe(true);

    const auditFixture = validArtifacts();
    const audit = join(auditFixture.root, "051_audit_wp050_implementation.md");
    writeFileSync(audit, "");
    expect(scanEvidence([...auditFixture.paths, audit]).some(error => error.includes("empty"))).toBe(true);
    writeFileSync(audit, "VERDICT: BLOCKED\n");
    expect(scanEvidence([...auditFixture.paths, audit]).some(error => error.includes("missing PASS"))).toBe(true);
  });
});

describe("OpenAI hardening final gate runner", () => {
  test("runs once in order, writes one sanitized summary, then scans", async () => {
    const order: string[] = [];
    const writes: string[] = [];
    const plan: GateSpec[] = [{ name: "one", command: ["one"] }, { name: "two", command: ["two"] }];
    const results: Record<string, GateResult> = {
      one: { exitCode: 0, output: "3 pass\nraw-private-output" },
      two: { exitCode: 0, output: "built in 1ms\n" },
    };
    const summary = await runGateSequence(plan, {
      run: async gate => { order.push(`run:${gate.name}`); return results[gate.name]!; },
      writeSummary: text => { order.push("write"); writes.push(text); },
      scan: () => { order.push("scan"); return []; },
    });
    expect(order).toEqual(["run:one", "run:two", "write", "scan"]);
    expect(writes).toHaveLength(1);
    expect(summary).not.toContain("raw-private-output");
    expect(summary).toContain("command[0]=one|exit=0|pass=3|fail=na|build=na");
    expect(summary).toContain("command[1]=two|exit=0|pass=na|fail=na|build=pass");
  });

  test("stops on the first failure without publishing or scanning", async () => {
    const order: string[] = [];
    await expect(runGateSequence([
      { name: "one", command: ["one"] },
      { name: "broken", command: ["broken"] },
      { name: "never", command: ["never"] },
    ], {
      run: async gate => {
        order.push(gate.name);
        return { exitCode: gate.name === "broken" ? 7 : 0, output: "" };
      },
      writeSummary: () => order.push("write"),
      scan: () => { order.push("scan"); return []; },
    })).rejects.toThrow("gate failed: broken (7)");
    expect(order).toEqual(["one", "broken"]);
  });
});

describe("OpenAI hardening live policy and runtime isolation", () => {
  const base = liveOutcome("openai-apikey/gpt-5.6-sol");
  const pro = liveOutcome("openai-apikey/gpt-5.6-sol-pro");

  test("covers unavailable, unauthorized, successful, failed, and mismatched live decisions", () => {
    expect(evaluateLivePolicy(false, false, [])).toEqual({ status: "NOT RUN (credential unavailable)", liveCalls: 0, failed: false });
    expect(evaluateLivePolicy(true, false, [])).toEqual({ status: "NOT RUN (live spend not authorized)", liveCalls: 0, failed: false });
    expect(evaluateLivePolicy(true, true, [base, pro])).toEqual({ status: "LIVE PASS", liveCalls: 2, failed: false });
    expect(evaluateLivePolicy(true, true, [{ ...base, status: 500 }, pro]).failed).toBe(true);
    expect(evaluateLivePolicy(true, true, [base, { ...pro, status: 500 }]).failed).toBe(true);
    expect(evaluateLivePolicy(true, true, [base, { ...pro, resolvedId: "wrong" }]).failed).toBe(true);
    expect(evaluateLivePolicy(true, true, [{ ...base, selectedId: "wrong" }, pro]).failed).toBe(true);
  });

  test("removes credential and proxy sentinels while preserving safe process state", () => {
    const source = {
      PATH: "/bin",
      OPENAI_API_KEY: "sentinel",
      openai_base_url: "sentinel",
      CODEX_HOME: "sentinel",
      codex_api_key: "sentinel",
      OPENCODEX_HOME: "sentinel",
      opencodex_base_url: "sentinel",
      HTTP_PROXY: "sentinel",
      https_proxy: "sentinel",
      ALL_PROXY: "sentinel",
      all_proxy: "sentinel",
    };
    const env = buildSanitizedRuntimeEnv(source, "/tmp/ocx", "/tmp/codex");
    expect(env.PATH).toBe("/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.openai_base_url).toBeUndefined();
    expect(env.codex_api_key).toBeUndefined();
    expect(env.opencodex_base_url).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    expect(env.OPENCODEX_HOME).toBe("/tmp/ocx");
    expect(env.CODEX_HOME).toBe("/tmp/codex");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
    expect(env.OCX_SHIM_BYPASS).toBe("1");
  });
});
