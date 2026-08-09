import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendLabEvent,
  assignEventId,
  buildInvalidationIndex,
  claimSourceManifestDigest,
  createArtifactStore,
  eventIdForPayload,
  isSha256Hex,
  jcsStringify,
  observationFromConformanceResult,
  openTrustedArtifactDir,
  persistConformanceResult,
  projectVerdicts,
  purgeSensitiveEvidence,
  readVerdictSnapshot,
  rebuildLabProjection,
  replayLabLedger,
  resolveClaimStates,
  subjectIdForSubject,
  validateClaimSourceManifest,
  validateLabEvent,
  validateSortedUniqueHexIds,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  LAB_PROJECTION_SPEC_VERSION,
} from "../src/lab";
import { ArtifactFsError, putArtifactBytes, putNamedDigestBytes, readArtifactBytes, digestFileName } from "../src/lab/artifacts/secure-fs";
import { discoverScenarios, loadCaseAuthority } from "../src/lab/conformance/manifest";
import { runScenario } from "../src/lab/conformance/executor";
import type { ClaimSnapshotEvent, ObservationEvent, ProtocolSubjectV1 } from "../src/lab/events/types";

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

beforeEach(() => {
  // OPENCODEX_HOME isolation
});

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.OPENCODEX_HOME;
});

function withHome<T>(fn: (home: string) => T): T {
  const home = tempHome();
  process.env.OPENCODEX_HOME = home;
  return fn(home);
}

function protocolSubject(seed = "a"): ProtocolSubjectV1 {
  return {
    subjectSchemaVersion: 1,
    subjectKind: "protocol",
    opencodexCompatibilityVersion: "protocol-v1",
    effectiveAdapter: "openai-chat",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
    behaviorFingerprint: createHashHex(seed),
  };
}

function createHashHex(s: string): string {
  return Bun.CryptoHasher.hash("sha256", s, "hex");
}

function baseObservation(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  const subject = protocolSubject(overrides.scenarioId ?? "s1");
  const subjectId = subjectIdForSubject(subject);
  const fixtureDigest = createHashHex("fixture");
  const scenarioManifestDigest = createHashHex("scenario");
  const suiteManifestDigest = createHashHex("suite");
  const event = assignEventId({
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    eventKind: "observation" as const,
    recordedAt: 1_700_000_000_000,
    producer: LAB_PRODUCER,
    producerVersion: "2.10.2",
    evidenceLayer: "protocol_conformance" as const,
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1",
    scenarioManifestDigest,
    suiteId: "responses-core",
    suiteVersion: "1",
    suiteManifestDigest,
    fixtureDigests: [fixtureDigest],
    subject,
    subjectId,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_100,
    executionMode: "fixture" as const,
    attempt: 1,
    limits: { maxWallClockMs: 1000 },
    outcome: "pass" as const,
    assertions: [
      {
        id: "a1",
        operator: "equals",
        required: true,
        passed: true,
        expectedSummary: "ok",
        observedSummary: "ok",
      },
    ],
    environment: { runtime: { platform: "test" } },
    artifactRefs: [
      {
        digest: scenarioManifestDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${scenarioManifestDigest}.bin`,
        artifactClass: "scenario_manifest",
      },
      {
        digest: suiteManifestDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${suiteManifestDigest}.bin`,
        artifactClass: "suite_manifest",
      },
      {
        digest: fixtureDigest,
        mediaType: "application/json",
        byteCount: 2,
        redactionPolicy: "contract_canonical_v1",
        relativePath: `${fixtureDigest}.bin`,
        artifactClass: "fixture",
      },
    ],
    ...overrides,
  });
  return event as ObservationEvent;
}

describe("CL-02 JCS and IDs", () => {
  test("eventId and subjectId are domain-separated deterministic digests", () => {
    const subject = protocolSubject("x");
    const subjectId = subjectIdForSubject(subject);
    expect(isSha256Hex(subjectId)).toBe(true);
    expect(subjectId).toBe(subjectIdForSubject(subject));

    const payload = {
      schemaVersion: 1,
      eventKind: "invalidation",
      recordedAt: 1,
      producer: "p",
      producerVersion: "1",
      targetEventIds: [createHashHex("t")],
      reason: "harness_defect",
    };
    const id1 = eventIdForPayload(payload);
    const id2 = eventIdForPayload(payload);
    expect(id1).toBe(id2);
    expect(isSha256Hex(id1)).toBe(true);
    // Domain separation: different domain changes digest
    expect(id1).not.toBe(subjectId);
  });

  test("JCS key order is deterministic", () => {
    expect(jcsStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("CL-02 ledger append/replay", () => {
  test("append and replay round-trip", () => {
    withHome((home) => {
      const event = baseObservation();
      // Store required artifacts as opaque named digests for projection
      const store = createArtifactStore(join(home, "lab", "artifacts"));
      for (const ref of event.artifactRefs) {
        store.put({
          artifactClass: "assertion_report",
          payload: { ok: true, seed: ref.digest },
          expectedDigest: undefined,
        });
      }
      // Write contract-named bytes for digests referenced by the event
      const dir = openTrustedArtifactDir(join(home, "lab", "artifacts"));
      for (const ref of event.artifactRefs) {
        putNamedDigestBytes(dir, ref.digest, new TextEncoder().encode("{}"), () => ref.digest);
      }

      appendLabEvent(join(home, "lab", "compatibility.jsonl"), event);
      const replay = replayLabLedger(join(home, "lab", "compatibility.jsonl"));
      expect(replay.validLineCount).toBe(1);
      expect(replay.events[0]!.eventId).toBe(event.eventId);
      expect(replay.corruptions).toEqual([]);
    });
  });

  test("partial final JSONL line is corruption", () => {
    withHome((home) => {
      const ledger = join(home, "lab", "compatibility.jsonl");
      mkdirSync(join(home, "lab"), { recursive: true });
      writeFileSync(ledger, '{"schemaVersion":1,"eventKind":"observation"');
      const replay = replayLabLedger(ledger);
      expect(replay.events).toEqual([]);
      expect(replay.corruptions.some((c) => c.kind === "partial_line")).toBe(true);
    });
  });

  test("malformed line is corruption and contributes no evidence", () => {
    withHome((home) => {
      const ledger = join(home, "lab", "compatibility.jsonl");
      mkdirSync(join(home, "lab"), { recursive: true });
      writeFileSync(ledger, "not-json\n");
      const replay = replayLabLedger(ledger);
      expect(replay.events).toEqual([]);
      expect(replay.corruptions.some((c) => c.kind === "malformed_line")).toBe(true);
    });
  });

  test("duplicate eventId is reported", () => {
    withHome((home) => {
      const event = baseObservation();
      const ledger = join(home, "lab", "compatibility.jsonl");
      mkdirSync(join(home, "lab"), { recursive: true });
      const line = `${jcsStringify(event)}\n`;
      writeFileSync(ledger, line + line);
      const replay = replayLabLedger(ledger);
      expect(replay.validLineCount).toBe(1);
      expect(replay.corruptions.some((c) => c.kind === "duplicate_event")).toBe(true);
    });
  });
});

describe("CL-02 invalidation validation", () => {
  test("rejects unsorted, duplicate, empty, and oversize target lists", () => {
    expect(() => validateSortedUniqueHexIds([], "t", { nonEmpty: true })).toThrow();
    const a = createHashHex("a");
    const b = createHashHex("b");
    const [lo, hi] = a < b ? [a, b] : [b, a];
    expect(() => validateSortedUniqueHexIds([hi, lo], "t")).toThrow();
    expect(() => validateSortedUniqueHexIds([lo, lo], "t")).toThrow();
    expect(validateSortedUniqueHexIds([lo, hi], "t")).toEqual([lo, hi]);
  });

  test("invalidation targets must be earlier observation/claim only", () => {
    const obs = baseObservation();
    const inv = assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "invalidation" as const,
      recordedAt: obs.recordedAt + 1,
      producer: LAB_PRODUCER,
      producerVersion: "2.10.2",
      targetEventIds: [obs.eventId],
      reason: "harness_defect" as const,
    });
    const index = buildInvalidationIndex([obs, inv as never]);
    expect(index.invalidatedBy.has(obs.eventId)).toBe(true);
    expect(index.corruptions).toEqual([]);

    const bad = assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "invalidation" as const,
      recordedAt: obs.recordedAt + 2,
      producer: LAB_PRODUCER,
      producerVersion: "2.10.2",
      targetEventIds: [createHashHex("missing")],
      reason: "fixture_defect" as const,
    });
    const index2 = buildInvalidationIndex([obs, bad as never]);
    expect(index2.corruptions.some((c) => c.kind === "invalid_reference")).toBe(true);
  });
});

describe("CL-02 claim supersession and conflicts", () => {
  test("supersession leaves one current claim; conflicts report corruption", () => {
    const subject = {
      subjectSchemaVersion: 1 as const,
      subjectKind: "route" as const,
      providerId: "openai",
      providerInstanceFingerprint: createHashHex("inst"),
      clientModelId: "gpt",
      upstreamModelId: "gpt",
      effectiveAdapter: "openai-responses",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-responses",
      surface: "responses-http",
      opencodexCompatibilityVersion: "protocol-v1",
      behaviorFingerprint: createHashHex("bf"),
      endpointFingerprint: createHashHex("ep"),
      dependencies: [],
    };
    const subjectId = subjectIdForSubject(subject);
    const manifest = validateClaimSourceManifest({
      schemaVersion: 1,
      subjectId,
      providerId: "openai",
      clientModelId: "gpt",
      capability: "tools",
      sources: [
        {
          kind: "provider_registry",
          revision: "1",
          facts: { toolCapable: true },
        },
      ],
      resolvedEvidence: { tools: true },
    });

    const c1 = assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "claim_snapshot" as const,
      recordedAt: 10,
      producer: LAB_PRODUCER,
      producerVersion: "2.10.2",
      evidenceLayer: "live_route_compatibility" as const,
      subject,
      subjectId,
      capability: "tools",
      polarity: "supported" as const,
      sourceManifestDigest: manifest.digest,
      sourceEventIds: [],
      supersedes: [],
      effectiveAt: 10,
    }) as ClaimSnapshotEvent;

    const c2 = assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "claim_snapshot" as const,
      recordedAt: 20,
      producer: LAB_PRODUCER,
      producerVersion: "2.10.2",
      evidenceLayer: "live_route_compatibility" as const,
      subject,
      subjectId,
      capability: "tools",
      polarity: "supported" as const,
      sourceManifestDigest: manifest.digest,
      sourceEventIds: [],
      supersedes: [c1.eventId],
      effectiveAt: 20,
    }) as ClaimSnapshotEvent;

    const ok = resolveClaimStates([c1, c2]);
    expect(ok.states.get(`${subjectId}|tools`)?.current?.eventId).toBe(c2.eventId);

    const c3 = assignEventId({
      ...c2,
      eventId: undefined,
      recordedAt: 30,
      effectiveAt: 30,
      supersedes: [],
    }) as ClaimSnapshotEvent;
    const conflict = resolveClaimStates([c1, c2, c3]);
    expect(conflict.states.get(`${subjectId}|tools`)?.corruption).toBeTruthy();
  });

  test("ClaimSourceManifest rejects secrets and unknown facts", () => {
    expect(() =>
      validateClaimSourceManifest({
        schemaVersion: 1,
        subjectId: createHashHex("s"),
        providerId: "openai",
        clientModelId: "gpt",
        capability: "tools",
        sources: [{ kind: "provider_config", revision: null, facts: { baseUrl: "https://evil" } }],
        resolvedEvidence: {},
      }),
    ).toThrow();
  });
});

describe("CL-02 artifacts and secure FS", () => {
  test("content-addressed put/get and size ceiling", () => {
    withHome((home) => {
      const store = createArtifactStore(join(home, "lab", "artifacts"));
      const ref = store.put({ artifactClass: "assertion_report", payload: { a: 1 } });
      expect(isSha256Hex(ref.digest)).toBe(true);
      const bytes = store.get(ref.digest);
      expect(bytes.byteLength).toBe(ref.byteCount);

      const huge = new Uint8Array(256 * 1024 + 1);
      expect(() =>
        store.put({ artifactClass: "assertion_report", payload: huge }),
      ).toThrow();
    });
  });

  test("traversal and absolute digest names are rejected", () => {
    withHome((home) => {
      const dir = openTrustedArtifactDir(join(home, "lab", "artifacts"));
      expect(() => digestFileName("../passwd")).toThrow();
      expect(() => digestFileName("C:\\Windows\\x")).toThrow();
      expect(() => readArtifactBytes(dir, "../aaaa")).toThrow();
    });
  });

  test("symlink attack fails closed where testable", () => {
    withHome((home) => {
      const artifacts = join(home, "lab", "artifacts");
      mkdirSync(artifacts, { recursive: true });
      const target = join(home, "outside.bin");
      writeFileSync(target, "secret-canary-symlink");
      const digest = createHashHex("symlink-target");
      const linkPath = join(artifacts, `${digest}.bin`);
      try {
        symlinkSync(target, linkPath);
      } catch {
        // Windows may require elevation for symlinks
        return;
      }
      const dir = openTrustedArtifactDir(artifacts);
      expect(() => readArtifactBytes(dir, digest, { contentDigest: () => digest })).toThrow(ArtifactFsError);
    });
  });

  test("hard-link attack fails closed where testable", () => {
    withHome((home) => {
      const artifacts = join(home, "lab", "artifacts");
      const dir = openTrustedArtifactDir(artifacts);
      const bytes = new TextEncoder().encode("hl");
      const stored = putArtifactBytes(dir, bytes);
      const second = join(artifacts, `${createHashHex("other")}.bin`);
      try {
        linkSync(join(artifacts, `${stored.digest}.bin`), second);
      } catch {
        return;
      }
      // nlink should now be 2 on original
      expect(() => readArtifactBytes(dir, stored.digest)).toThrow();
    });
  });

  test("digest mismatch fails closed", () => {
    withHome((home) => {
      const dir = openTrustedArtifactDir(join(home, "lab", "artifacts"));
      const bytes = new TextEncoder().encode("abc");
      expect(() => putArtifactBytes(dir, bytes, createHashHex("wrong"))).toThrow();
    });
  });
});

describe("CL-02 projection rebuild determinism", () => {
  test("rebuild twice reproduces the same non-purged derived verdict rows", () => {
    withHome((home) => {
      const authority = loadCaseAuthority();
      const scenarios = discoverScenarios(authority, ["responses-core"]);
      const caseRecord = scenarios[0]!;
      // Use a lightweight synthetic pass result without running full harness for speed
      // but still go through the CL-01 seam types.
      const result = {
        scenarioId: caseRecord.id,
        suite: caseRecord.suite,
        passed: true,
        classification: "protocol_failure" as const,
        assertionResults: caseRecord.assertions.map((a) => ({
          id: a.id,
          operator: a.operator,
          required: a.required,
          passed: true,
          observedSummary: "ok",
        })),
        diagnostics: [],
      };
      persistConformanceResult(result, caseRecord, authority, {
        configDir: home,
        recordedAt: 1_700_000_000_000,
      });

      const first = rebuildLabProjection(home);
      const snap1 = readVerdictSnapshot(first.sqlitePath);
      const second = rebuildLabProjection(home);
      const snap2 = readVerdictSnapshot(second.sqlitePath);
      const third = rebuildLabProjection(home);
      const snap3 = readVerdictSnapshot(third.sqlitePath);
      expect(snap1).toEqual(snap2);
      expect(snap2).toEqual(snap3);
      expect(snap1.length).toBeGreaterThan(0);
      expect((snap1[0] as { verdict: string }).verdict).toBe("VERIFIED");
      expect((snap1[0] as { projection_spec_version: string }).projection_spec_version).toBe(
        LAB_PROJECTION_SPEC_VERSION,
      );
    });
  });

  test("projection after invalidation excludes evidence", () => {
    withHome((home) => {
      const authority = loadCaseAuthority();
      const caseRecord = discoverScenarios(authority, ["responses-core"])[0]!;
      const { event } = persistConformanceResult(
        {
          scenarioId: caseRecord.id,
          suite: caseRecord.suite,
          passed: true,
          classification: "protocol_failure",
          assertionResults: [],
          diagnostics: [],
        },
        caseRecord,
        authority,
        { configDir: home, recordedAt: 1000 },
      );
      const inv = assignEventId({
        schemaVersion: LAB_EVENT_SCHEMA_VERSION,
        eventKind: "invalidation" as const,
        recordedAt: 2000,
        producer: LAB_PRODUCER,
        producerVersion: "2.10.2",
        targetEventIds: [event.eventId],
        reason: "harness_defect" as const,
      });
      appendLabEvent(join(home, "lab", "compatibility.jsonl"), inv as never);
      const rebuilt = rebuildLabProjection(home);
      const snap = readVerdictSnapshot(rebuilt.sqlitePath);
      expect(snap.length).toBe(0);
    });
  });

  test("projection after purge drops purged evidence", () => {
    withHome((home) => {
      const authority = loadCaseAuthority();
      const caseRecord = discoverScenarios(authority, ["chat-core"])[0]!;
      const { event } = persistConformanceResult(
        {
          scenarioId: caseRecord.id,
          suite: caseRecord.suite,
          passed: true,
          classification: "protocol_failure",
          assertionResults: [],
          diagnostics: [],
        },
        caseRecord,
        authority,
        { configDir: home, recordedAt: 1000 },
      );
      purgeSensitiveEvidence({
        configDir: home,
        targetEventIds: [event.eventId],
        targetArtifactDigests: event.fixtureDigests.slice().sort(),
        recordedAt: 2000,
      });
      const rebuilt = rebuildLabProjection(home);
      const snap = readVerdictSnapshot(rebuilt.sqlitePath);
      expect(snap.every((row) => {
        const ids = JSON.parse((row as { contributing_event_ids_json: string }).contributing_event_ids_json) as string[];
        return !ids.includes(event.eventId);
      })).toBe(true);
    });
  });
});

describe("CL-02 CL-01 integration", () => {
  test("run → observation → JSONL → replay → SQLite protocol projection", async () => {
    await withHome(async (home) => {
      const authority = loadCaseAuthority();
      const caseRecord = discoverScenarios(authority, ["responses-core"]).find(
        (c) => c.id === "responses-core.protocol.request-shape",
      )!;
      const result = await runScenario(caseRecord);
      expect(result.passed).toBe(true);
      const { event } = observationFromConformanceResult(result, caseRecord, authority, {
        configDir: home,
        recordedAt: 1_800_000_000_000,
      });
      expect(validateLabEvent(event).eventKind).toBe("observation");
      persistConformanceResult(result, caseRecord, authority, {
        configDir: home,
        recordedAt: 1_800_000_000_000,
      });
      const replay = replayLabLedger(join(home, "lab", "compatibility.jsonl"));
      expect(replay.validLineCount).toBe(1);
      const rebuilt = rebuildLabProjection(home);
      expect(rebuilt.events).toBe(1);
      const snap = readVerdictSnapshot(rebuilt.sqlitePath);
      expect(snap.length).toBe(1);
      expect((snap[0] as { evidence_layer: string }).evidence_layer).toBe("protocol_conformance");
      expect((snap[0] as { verdict: string }).verdict).toBe("VERIFIED");
      const projected = projectVerdicts(replay.events);
      expect(projected.verdicts[0]!.verdict).toBe("VERIFIED");
    });
  });
});

describe("CL-02 privacy canaries", () => {
  test("sanitizer strips secret-shaped and path material from evidence artifacts", () => {
    withHome((home) => {
      const store = createArtifactStore(join(home, "lab", "artifacts"));
      const ref = store.put({
        artifactClass: "error_taxonomy",
        payload: {
          message: "failed sk-abcdefghijklmnopqrstuvwxyz123456",
          path: "C:\\Users\\victim\\secrets\\token.txt",
          authorization: "Bearer SUPERSECRET",
          url: "https://user:pass@example.com/v1",
        },
      });
      const text = new TextDecoder().decode(store.get(ref.digest));
      expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(text).not.toContain("SUPERSECRET");
      expect(text).not.toContain("victim");
      expect(text).not.toContain("user:pass");
    });
  });
});

describe("CL-02 empty/corrupt ledger", () => {
  test("empty ledger reports corruption and rebuilds empty projection", () => {
    withHome((home) => {
      mkdirSync(join(home, "lab"), { recursive: true });
      writeFileSync(join(home, "lab", "compatibility.jsonl"), "");
      const replay = replayLabLedger(join(home, "lab", "compatibility.jsonl"));
      expect(replay.corruptions.some((c) => c.kind === "empty_ledger")).toBe(true);
      const rebuilt = rebuildLabProjection(home);
      expect(readVerdictSnapshot(rebuilt.sqlitePath)).toEqual([]);
    });
  });
});

// Keep chmod import used on POSIX permission smoke (best-effort).
void chmodSync;
void existsSync;
void claimSourceManifestDigest;
