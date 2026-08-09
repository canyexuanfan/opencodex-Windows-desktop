import { MAX_BYTES_PER_ARTIFACT, MAX_AGGREGATE_ARTIFACT_BYTES, MAX_ARTIFACTS_PER_RUN, ARTIFACT_FILENAME_EXT, type ArtifactClass, type ContractArtifactClass } from "../constants";
import {
  artifactBytesDigest,
  claimSourceManifestDigest,
  fixtureDigest,
  isSha256Hex,
  jcsStringify,
  scenarioManifestDigest,
  suiteManifestDigest,
} from "../digest";
import type { ArtifactRefV1, ClaimSourceManifestV1 } from "../events/types";
import { artifactClassMediaType, validateClaimSourceManifest } from "../events/validate";
import {
  closeTrustedArtifactDir,
  ArtifactFsError,
  deleteArtifactBytes,
  openTrustedArtifactDir,
  putArtifactBytes,
  putNamedDigestBytes,
  readArtifactBytes,
  type TrustedArtifactDir,
} from "./secure-fs";
import { redactForArtifact } from "./sanitize";

export { ArtifactFsError, openTrustedArtifactDir };
export type { TrustedArtifactDir };

export interface PutArtifactInput {
  artifactClass: ArtifactClass;
  /** Pre-redaction payload; sanitizer runs before hash/write. */
  payload: Uint8Array | string | unknown;
  mediaType?: string;
  redactionPolicy?: string;
  /** For contract artifacts whose digest uses a domain other than artifact-bytes. */
  expectedDigest?: string;
}

export interface ArtifactStore {
  dir: TrustedArtifactDir;
  put(input: PutArtifactInput): ArtifactRefV1;
  get(digest: string, expectedByteCount?: number): Uint8Array;
  getVerified(digest: string, expectedByteCount?: number): { bytes: Uint8Array; digest: string };
  remove(digest: string): void;
  close(): void;
}

function toBytes(payload: Uint8Array | string | unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return new TextEncoder().encode(jcsStringify(payload));
}

export function createArtifactStore(artifactsDir: string): ArtifactStore {
  const dir = openTrustedArtifactDir(artifactsDir);
  let aggregateBytes = 0;
  let putCount = 0;

  return {
    dir,
    put(input: PutArtifactInput): ArtifactRefV1 {
      if (putCount >= MAX_ARTIFACTS_PER_RUN) {
        throw new ArtifactFsError("budget_exhausted", "maximum artifacts per run exceeded");
      }
      if (input.payload instanceof Uint8Array && input.payload.byteLength > MAX_BYTES_PER_ARTIFACT) {
        throw new ArtifactFsError("budget_exhausted", `artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
      }
      if (typeof input.payload === "string" && new TextEncoder().encode(input.payload).byteLength > MAX_BYTES_PER_ARTIFACT) {
        throw new ArtifactFsError("budget_exhausted", `artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
      }
      const redacted = redactForArtifact(input.artifactClass, input.payload);
      const bytes = toBytes(redacted);
      if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
        throw new ArtifactFsError("budget_exhausted", `artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
      }
      if (aggregateBytes + bytes.byteLength > MAX_AGGREGATE_ARTIFACT_BYTES) {
        throw new ArtifactFsError("budget_exhausted", "aggregate artifact ceiling exceeded");
      }

      let stored;
      if (isContractClass(input.artifactClass)) {
        const contractClass = input.artifactClass;
        const digest = input.expectedDigest ?? computeContractDigest(contractClass, bytes, redacted);
        if (input.expectedDigest && digest !== input.expectedDigest) {
          throw new ArtifactFsError("harness_failure", "contract artifact digest mismatch");
        }
        const contentDigest = (b: Uint8Array) =>
          computeContractDigest(contractClass, b, JSON.parse(new TextDecoder().decode(b)));
        // Fixtures hash raw bytes; JSON contract manifests hash parsed JCS object.
        const hashFn =
          contractClass === "fixture"
            ? (b: Uint8Array) => fixtureDigest(b)
            : contentDigest;
        if (hashFn(bytes) !== digest) {
          throw new ArtifactFsError("harness_failure", "contract artifact preimage digest mismatch");
        }
        stored = putNamedDigestBytes(dir, digest, bytes, hashFn);
      } else {
        stored = putArtifactBytes(dir, bytes, input.expectedDigest);
      }

      putCount += 1;
      aggregateBytes += stored.byteCount;
      return {
        digest: stored.digest,
        mediaType: input.mediaType ?? artifactClassMediaType(input.artifactClass),
        byteCount: stored.byteCount,
        redactionPolicy: input.redactionPolicy ?? defaultRedactionPolicy(input.artifactClass),
        relativePath: `${stored.digest}${ARTIFACT_FILENAME_EXT}`,
        artifactClass: input.artifactClass,
      };
    },
    get(digest: string, expectedByteCount?: number): Uint8Array {
      return this.getVerified(digest, expectedByteCount).bytes;
    },
    getVerified(digest: string, expectedByteCount?: number) {
      const candidates: Array<(b: Uint8Array) => string> = [
        artifactBytesDigest,
        fixtureDigest,
        (b) => {
          try {
            return scenarioManifestDigest(JSON.parse(new TextDecoder().decode(b)));
          } catch {
            return "";
          }
        },
        (b) => {
          try {
            return suiteManifestDigest(JSON.parse(new TextDecoder().decode(b)));
          } catch {
            return "";
          }
        },
        (b) => {
          try {
            return claimSourceManifestDigest(JSON.parse(new TextDecoder().decode(b)));
          } catch {
            return "";
          }
        },
      ];
      let lastErr: unknown;
      for (const contentDigest of candidates) {
        try {
          const got = readArtifactBytes(dir, digest, { expectedByteCount, contentDigest });
          if (got.digest === digest) return { bytes: got.bytes, digest: got.digest };
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new ArtifactFsError("harness_failure", "artifact digest verification failed");
    },
    remove(digest: string): void {
      deleteArtifactBytes(dir, digest);
    },
    close(): void {
      closeTrustedArtifactDir(dir);
    },
  };
}

function isContractClass(c: ArtifactClass): c is ContractArtifactClass {
  return (
    c === "scenario_manifest" ||
    c === "suite_manifest" ||
    c === "fixture" ||
    c === "claim_source_manifest"
  );
}

function computeContractDigest(
  artifactClass: ContractArtifactClass,
  bytes: Uint8Array,
  redacted: unknown,
): string {
  switch (artifactClass) {
    case "fixture":
      return fixtureDigest(bytes);
    case "scenario_manifest":
      return scenarioManifestDigest(
        typeof redacted === "object" && redacted ? (redacted as Record<string, unknown>) : JSON.parse(new TextDecoder().decode(bytes)),
      );
    case "suite_manifest":
      return suiteManifestDigest(
        typeof redacted === "object" && redacted ? (redacted as Record<string, unknown>) : JSON.parse(new TextDecoder().decode(bytes)),
      );
    case "claim_source_manifest": {
      const parsed = typeof redacted === "object" && redacted
        ? redacted
        : JSON.parse(new TextDecoder().decode(bytes));
      return claimSourceManifestDigest(validateClaimSourceManifest(parsed).manifest);
    }
    default: {
      const _never: never = artifactClass;
      return _never;
    }
  }
}

function defaultRedactionPolicy(artifactClass: ArtifactClass): string {
  switch (artifactClass) {
    case "scenario_manifest":
    case "suite_manifest":
    case "fixture":
    case "claim_source_manifest":
      return "contract_canonical_v1";
    default:
      return "sanitized_evidence_v1";
  }
}

export function putClaimSourceManifest(
  store: ArtifactStore,
  manifest: ClaimSourceManifestV1,
): ArtifactRefV1 {
  const { manifest: validated, digest } = validateClaimSourceManifest(manifest);
  return store.put({
    artifactClass: "claim_source_manifest",
    payload: validated,
    expectedDigest: digest,
  });
}

export function loadClaimSourceManifest(
  store: ArtifactStore,
  digest: string,
  expected: { subjectId: string; capability: string },
): { manifest: ClaimSourceManifestV1; corruption?: string } {
  if (!isSha256Hex(digest)) return { manifest: null as unknown as ClaimSourceManifestV1, corruption: "invalid digest" };
  try {
    const bytes = store.get(digest);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const { manifest, digest: recomputed } = validateClaimSourceManifest(parsed);
    if (recomputed !== digest) return { manifest, corruption: "claim-source digest mismatch" };
    if (manifest.subjectId !== expected.subjectId) return { manifest, corruption: "claim-source subjectId mismatch" };
    if (manifest.capability !== expected.capability) return { manifest, corruption: "claim-source capability mismatch" };
    return { manifest };
  } catch (err) {
    return {
      manifest: null as unknown as ClaimSourceManifestV1,
      corruption: err instanceof Error ? err.message : String(err),
    };
  }
}
