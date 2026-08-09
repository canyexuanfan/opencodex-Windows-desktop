/**
 * CL-05 Compatibility Matrix — shared types and matrix helpers.
 * Read-only DTO shapes mirror GET /api/lab/* responses.
 */

export const EVIDENCE_LAYERS = [
  "protocol_conformance",
  "live_route_compatibility",
  "task_effectiveness",
] as const;

export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];

export const COMPATIBILITY_VERDICTS = [
  "UNKNOWN",
  "CLAIMED",
  "PROBED",
  "VERIFIED",
  "DEGRADED",
  "BLOCKED",
  "UNSUPPORTED",
] as const;

export type CompatibilityVerdict = (typeof COMPATIBILITY_VERDICTS)[number];

export type LabStatusDto = {
  projectionAvailable: boolean;
  projectionIncompatible?: boolean;
  sqliteSchemaVersion?: number;
  projectionSpecVersion?: string;
  builtAtMs?: number;
  eventCount?: number;
  subjectCount?: number;
  observationCount?: number;
  claimCount?: number;
  verdictCount?: number;
  artifactCount?: number;
  corruptionCount?: number;
};

export type VerdictDto = {
  projectionKey: string;
  subjectId: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  projectionSpecVersion: string;
  verdict: CompatibilityVerdict;
  asOf: number;
  scenarioManifestDigests: string[];
  claimSourceDigest: string | null;
  contributingEventIds: string[];
  contradictingEventIds: string[];
  notes: string[];
};

export type SubjectListItemDto = {
  subjectId: string;
  subjectKind: string;
};

export type PaginatedVerdicts = {
  verdicts: VerdictDto[];
  hasMore: boolean;
  nextCursor?: string;
};

export type PaginatedSubjects = {
  subjects: SubjectListItemDto[];
  hasMore: boolean;
  nextCursor?: string;
};

export type MatrixRow = {
  subjectId: string;
  subjectKind: string;
  byLayer: Record<EvidenceLayer, VerdictDto[]>;
};

export type VerdictFilters = {
  layer: EvidenceLayer | "";
  verdict: CompatibilityVerdict | "";
  subjectQuery: string;
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseLabStatus(raw: unknown): LabStatusDto | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.projectionAvailable !== "boolean") return null;
  return raw as LabStatusDto;
}

export function parseVerdictDto(raw: unknown): VerdictDto | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.subjectId !== "string") return null;
  if (typeof raw.evidenceLayer !== "string") return null;
  if (!EVIDENCE_LAYERS.includes(raw.evidenceLayer as EvidenceLayer)) return null;
  if (typeof raw.suiteId !== "string") return null;
  if (typeof raw.verdict !== "string") return null;
  if (!COMPATIBILITY_VERDICTS.includes(raw.verdict as CompatibilityVerdict)) return null;
  return raw as VerdictDto;
}

export function parseVerdictPage(raw: unknown): PaginatedVerdicts {
  if (!isPlainObject(raw) || !Array.isArray(raw.verdicts)) {
    return { verdicts: [], hasMore: false };
  }
  const verdicts = raw.verdicts
    .map(parseVerdictDto)
    .filter((row): row is VerdictDto => row !== null);
  return {
    verdicts,
    hasMore: raw.hasMore === true,
    nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
  };
}

export function parseSubjectPage(raw: unknown): PaginatedSubjects {
  if (!isPlainObject(raw) || !Array.isArray(raw.subjects)) {
    return { subjects: [], hasMore: false };
  }
  const subjects = raw.subjects.filter((row): row is SubjectListItemDto => {
    if (!isPlainObject(row)) return false;
    return typeof row.subjectId === "string" && typeof row.subjectKind === "string";
  });
  return {
    subjects,
    hasMore: raw.hasMore === true,
    nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
  };
}

export function emptyLayerMap(): Record<EvidenceLayer, VerdictDto[]> {
  return {
    protocol_conformance: [],
    live_route_compatibility: [],
    task_effectiveness: [],
  };
}

export function buildMatrixRows(
  verdicts: VerdictDto[],
  subjects: SubjectListItemDto[],
): MatrixRow[] {
  const kindById = new Map(subjects.map(row => [row.subjectId, row.subjectKind]));
  const bySubject = new Map<string, MatrixRow>();

  for (const verdict of verdicts) {
    let row = bySubject.get(verdict.subjectId);
    if (!row) {
      row = {
        subjectId: verdict.subjectId,
        subjectKind: kindById.get(verdict.subjectId) ?? "unknown",
        byLayer: emptyLayerMap(),
      };
      bySubject.set(verdict.subjectId, row);
    }
    row.byLayer[verdict.evidenceLayer].push(verdict);
  }

  return [...bySubject.values()].sort((a, b) => a.subjectId.localeCompare(b.subjectId));
}

export function filterVerdicts(verdicts: VerdictDto[], filters: VerdictFilters): VerdictDto[] {
  const query = filters.subjectQuery.trim().toLowerCase();
  return verdicts.filter(verdict => {
    if (filters.layer && verdict.evidenceLayer !== filters.layer) return false;
    if (filters.verdict && verdict.verdict !== filters.verdict) return false;
    if (query && !verdict.subjectId.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function shortSubjectId(subjectId: string): string {
  if (subjectId.length <= 16) return subjectId;
  return `${subjectId.slice(0, 8)}…${subjectId.slice(-6)}`;
}

export function formatAsOf(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "–";
  return new Date(ms).toLocaleString(locale);
}
