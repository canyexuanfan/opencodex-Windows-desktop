/**
 * SEC-02 regression: provider-controlled assertion text must not reach
 * persisted Lab evidence with network or account identifiers intact.
 *
 * These are activation tests, not coverage tests. Each end-to-end case drives a
 * real failing assertion through a real event constructor and asserts on the
 * persisted bytes, because a green suite does not demonstrate that a sanitizer
 * fired. Plan: devlog/_plan/260810_release_train_and_triage/040_sec02_remediation.md
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLiveCaseAuthority,
  observationFromConformanceResult,
  observationFromLiveResult,
  runLiveScenario,
} from "../src/lab";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import { runScenario } from "../src/lab/conformance/executor";
import { sanitizeDiagnostic, truncateUtf8 } from "../src/lab/artifacts/sanitize";
import { createArtifactStore } from "../src/lab/artifacts/store";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import { ensureLabDirs } from "../src/lab/paths";
import type { LabBehaviorValues, LabRouteContext } from "../src/lab/live/types";
import type { NormalizedObservation } from "../src/lab/conformance/types";

const HOMES: string[] = [];
function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-sanitize-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  delete process.env.OPENCODEX_HOME;
});

function behavior(adapter: string, upstreamProtocol: string): LabBehaviorValues {
  return {
    "wire.adapter": { source: "lab_forced", value: adapter }, "wire.upstreamProtocol": { source: "lab_forced", value: upstreamProtocol },
    "auth.mode": { source: "provider_config", value: "api_key" }, "auth.transport": { source: "provider_config", value: "authorization_bearer" },
    "mcp.nativeLocalExec": { source: "lab_forced", value: false }, "runtime.bunVersion": { source: "lab_forced", value: Bun.version },
    "runtime.platform": { source: "lab_forced", value: process.platform }, "runtime.arch": { source: "lab_forced", value: process.arch },
    "runtime.streamMode": { source: "lab_forced", value: "auto" }, "runtime.fastMode": { source: "lab_forced", value: false },
    "runtime.effortCap": { source: "lab_forced", value: null }, "headers.nonCredentialBehaviorDigest": { source: "provider_config", value: "0".repeat(64) },
  };
}

function mockRoute(): LabRouteContext {
  return {
    providerId: "fixture-provider", providerInstanceKey: "fixture-provider-instance", clientModelId: "fixture-model", upstreamModelId: "fixture-model",
    effectiveAdapter: "openai-responses", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses", surface: "responses-http",
    baseUrl: "https://api.example.com/v1", opencodexCompatibilityVersion: "a".repeat(64), labRunApproval: true, allowPrivateNetwork: false,
    requiredClaims: ["tools", "image", "reasoning"],
    availableHarnessFeatures: ["live_transport", "inert_tools", "adapter_vector", "reasoning_replay", "synthetic_image", "in_memory_mcp_stub", "mcp_call_result_v1", "mcp_lab_stub"],
    behaviorValues: behavior("openai-responses", "openai-responses"),
  } as unknown as LabRouteContext;
}

/** An observation whose normalized text carries a forbidden value. */
function observationWithText(text: string): NormalizedObservation {
  return {
    client: { request: { status: 200, headers: {}, json: {}, rawBytes: 0 }, response: { status: 200, headers: {}, json: {}, events: [], toolCalls: [], mcpCalls: [], terminal: "completed", normalizedText: text } },
    upstream: { requests: [], responses: [] }, process: { exitCode: null }, verifiers: {},
  };
}

// One value per case: live assertion summaries are capped at 120 characters
// (src/lab/conformance/assertion.ts), so packing them into one string would
// truncate the later ones out of the assertion before sanitization ever runs.
const FORBIDDEN: { label: string; raw: string; token: string }[] = [
  { label: "IPv4 literal", raw: "203.0.113.7", token: "[ip]" },
  { label: "IPv6 literal", raw: "2001:db8::1", token: "[ip]" },
  { label: "IPv4-mapped IPv6", raw: "::ffff:192.0.2.128", token: "[ip]" },
  { label: "scoped IPv6", raw: "fe80::1%en0", token: "[ip]" },
  { label: "MAC address", raw: "01:23:45:67:89:ab", token: "[mac]" },
  { label: "email address", raw: "ops@example.com", token: "[email]" },
  { label: "prefixed account id", raw: "acct_1A2b3C4d5E", token: "[account]" },
  // Userinfo is spelled with a placeholder rather than `u:p@host` so the
  // repository privacy scanner does not read the fixture itself as an address.
  { label: "other-scheme URI", raw: "s3://private-bucket/key", token: "[uri]" },
  { label: "bare hostname", raw: "internal.corp.example", token: "[host]" },
];

// Values the policy deliberately leaves alone. Redacting these would destroy
// the diagnostic value the Lab exists to capture.
const RESIDUALS = [
  "OK", "1.2.3", "v1.2.3.4", "12:34:56", "key:value",
  "user_profile", "user_profile1", "user_session",
  "org: engineering", "account: free-tier", "user: charlie",
  "tenant_id=x", "deadbeefcafe1234deadbeefcafe1234",
];

describe("SEC-02 sanitizer boundary", () => {
  test("every forbidden category is redacted", () => {
    for (const { label, raw, token } of FORBIDDEN) {
      const out = sanitizeDiagnostic(raw);
      expect(out, label).not.toContain(raw);
      expect(out, label).toContain(token);
    }
  });

  test("recorded residuals survive unchanged", () => {
    for (const value of RESIDUALS) {
      expect(sanitizeDiagnostic(value), value).toBe(value);
    }
  });

  test("identifiers survive neither punctuation, word boundaries, nor a URL path", () => {
    // Each row was a real bypass found by security re-review of the first fix.
    // The candidate alphabet includes `.` for mapped IPv6, so a trailing
    // sentence period was swallowed into the candidate and failed validation
    // as a whole, leaking the address.
    expect(sanitizeDiagnostic("connect to 2001:db8::1.")).toBe("connect to [ip].");
    expect(sanitizeDiagnostic("failed contacting ::ffff:192.0.2.128.")).toBe("failed contacting [ip].");
    // `\b` does not fire between `_` and a digit.
    expect(sanitizeDiagnostic("x_203.0.113.7")).toBe("x_[ip]");
    // `\b` stops at the first dot, which left `[host].internal` naming the host.
    expect(sanitizeDiagnostic("host=db_prod.internal")).toBe("host=[host]");
    // A retained URL path still carries account identifiers past the host rewrite.
    expect(sanitizeDiagnostic("https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000"))
      .toBe("https://[host]/users/[account]");
    expect(sanitizeDiagnostic("https://api.example.com/orgs/acct_1A2b3C4d5E"))
      .toBe("https://[host]/orgs/[account]");
  });

  test("compressed, punycode, and encoded forms are redacted whole", () => {
    // Second round of re-review bypasses. Rejecting every candidate ending in
    // `:` to strip sentence punctuation also skipped valid compressed forms.
    expect(sanitizeDiagnostic("2001:db8::")).toBe("[ip]");
    expect(sanitizeDiagnostic("fe80::")).toBe("[ip]");
    expect(sanitizeDiagnostic("::")).toBe("[ip]");
    // A punycode TLD contains hyphens; a letters-only final label stopped at
    // the first one and left the rest of the host visible.
    expect(sanitizeDiagnostic("xn--e1afmkfd.xn--p1ai")).toBe("[host]");
    // A percent-encoded identifier is still an identifier.
    expect(sanitizeDiagnostic("https://h.example/u/550E8400%2De29b%2D41d4%2Da716%2D446655440000"))
      .toBe("https://[host]/u/[account]");
  });

  test("double-encoded identifiers are decoded to a fixed point", () => {
    // `%252D` is an encoded percent sign: one decode pass leaves a still
    // reversible identifier, so decoding repeats until it stops changing.
    expect(sanitizeDiagnostic("https://h.example/u/550e8400%252De29b%252D41d4%252Da716%252D446655440000"))
      .toBe("https://[host]/u/[account]");
  });

  test("hostname redaction does not eat ordinary dotted diagnostics", () => {
    // Widening the final label for punycode initially swallowed these. A
    // sanitizer that destroys evidence fails the Lab's purpose as surely as
    // one that leaks it.
    for (const value of ["foo.bar-baz", "lib.v2-rc1", "release.v2", "metric.p95"]) {
      expect(sanitizeDiagnostic(value), value).toBe(value);
    }
    // Real hosts, including punycode, still go.
    expect(sanitizeDiagnostic("internal.corp.example")).toBe("[host]");
    expect(sanitizeDiagnostic("xn--e1afmkfd.xn--p1ai")).toBe("[host]");
  });

  test("contextual account values are replaced whole, never as a prefix", () => {
    expect(sanitizeDiagnostic("user_id=abc123def")).toBe("user_id=[account]");
    expect(sanitizeDiagnostic('"userId": "abc123def"')).toBe('"userId": "[account]"');
    // The defect this closes: a bounded capture left the tail behind.
    const overlong = `user_id=${"a".repeat(65)}`;
    expect(sanitizeDiagnostic(overlong)).toBe("user_id=[account]");
    // Out-of-grammar content means replace nothing rather than a prefix.
    expect(sanitizeDiagnostic('"userId":"abcdef$secret"')).toBe('"userId":"abcdef$secret"');
    expect(sanitizeDiagnostic('"userId":"abcdef')).toBe('"userId":"abcdef');
  });

  test("adversarial near-misses complete promptly (no catastrophic backtracking)", () => {
    const inputs = [":".repeat(4000), ".".repeat(4000), "@".repeat(4000), `${"a".repeat(2000)}@`, `user_id=${":".repeat(2000)}`];
    const started = Date.now();
    for (const input of inputs) sanitizeDiagnostic(input);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("truncation splits neither a code point nor a redaction marker", () => {
    // The 512-byte boundary lands inside `[account]`, so the marker is dropped
    // whole rather than left as a fragment a reader could mistake for content.
    const marker = truncateUtf8(`${"x".repeat(505)}[account]tail`, 512);
    expect(marker).toBe("x".repeat(505));
    const multibyte = truncateUtf8("한".repeat(400), 512);
    expect(new TextEncoder().encode(multibyte).byteLength).toBeLessThanOrEqual(512);
    expect(multibyte.includes("\uFFFD")).toBe(false);
  });
});

describe("SEC-02 activation on persisted evidence", () => {
  test("live constructor sanitizes both the event and the assertion report", async () => {
    for (const { label, raw, token } of FORBIDDEN) {
      const home = tempHome();
      process.env.OPENCODEX_HOME = home;
      const authority = loadLiveCaseAuthority();
      const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
      // A host-issued executor keeps the trusted receipt genuine. Supplying a
      // stub transport alongside it would be ignored: runLiveScenario branches
      // if (routeExecutor) ... else if (transport).
      const result = await runLiveScenario(caseRecord, mockRoute(), {
        configDir: home,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        routeExecutor: createHostIssuedLabRouteExecutor(async () => observationWithText(raw)),
      });
      const { event, artifacts } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });

      const serializedEvent = JSON.stringify(event);
      expect(serializedEvent, `${label} in event`).not.toContain(raw);

      const report = artifacts.find((a) => a.artifactClass === "assertion_report");
      expect(report, `${label} report present`).toBeDefined();
      const paths = ensureLabDirs(home);
      const store = createArtifactStore(paths.artifactsDir);
      try {
        const bytes = store.get(report!.digest, { artifactClass: "assertion_report" });
        const text = new TextDecoder().decode(bytes);
        expect(text, `${label} in artifact`).not.toContain(raw);
        expect(`${text}${serializedEvent}`, `${label} token`).toContain(token);
      } finally {
        store.close();
      }
    }
  });

  test("non-contract artifacts declare the v2 redaction policy", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      routeExecutor: createHostIssuedLabRouteExecutor(async () => observationWithText("203.0.113.7")),
    });
    const { artifacts } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });
    const report = artifacts.find((a) => a.artifactClass === "assertion_report");
    expect(report?.redactionPolicy).toBe("sanitized_evidence_v2");
    // Contract classes keep their canonical policy and their pinned digests.
    const fixture = artifacts.find((a) => a.artifactClass === "fixture");
    expect(fixture?.redactionPolicy).toBe("contract_canonical_v1");
  });

  test("conformance constructor sanitizes both the event and the assertion report", async () => {
    // The conformance path has no trusted-receipt requirement, so the result
    // can be built directly. Covering it separately matters: removing the
    // sanitizer from this constructor alone would otherwise pass unnoticed.
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadCaseAuthority();
    const caseRecord = discoverScenarios(authority, ["responses-core"]).find(
      (c) => c.id === "responses-core.protocol.request-shape",
    )!;
    const startedAt = Date.now();
    const result = await runScenario(caseRecord);
    const completedAt = Date.now();
    const raw = "203.0.113.7";
    const tainted = {
      ...result,
      assertionResults: result.assertionResults.map((a, index) =>
        index === 0 ? { ...a, passed: false, observedSummary: `upstream ${raw} refused` } : a,
      ),
    };

    const { event, artifacts } = observationFromConformanceResult(tainted, caseRecord, authority, {
      configDir: home,
      recordedAt: completedAt,
      startedAt,
      completedAt,
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(raw);
    expect(serialized).toContain("[ip]");

    const report = artifacts.find((a) => a.artifactClass === "assertion_report");
    expect(report).toBeDefined();
    const paths = ensureLabDirs(home);
    const store = createArtifactStore(paths.artifactsDir);
    try {
      const text = new TextDecoder().decode(store.get(report!.digest, { artifactClass: "assertion_report" }));
      expect(text).not.toContain(raw);
    } finally {
      store.close();
    }
  });
});
