/**
 * CL-05 Compatibility Matrix - shared types and matrix helpers.
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

export type SubjectDetailDto = {
  subjectKind: string;
  subjectSchemaVersion?: number;
  [key: string]: unknown;
};

export type ObservationDto = {
  eventId: string;
  subjectId: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  outcome: string;
  completedAt: number;
  executionMode: string;
  excluded: boolean;
  exclusionReason: string | null;
};

export type EventListItemDto = {
  eventId: string;
  eventKind: string;
  recordedAt: number;
  excluded: boolean;
  exclusionReason: string | null;
};

export type LabEventDto = {
  eventKind: string;
  eventId: string;
  recordedAt: number;
  producer: string;
  producerVersion: string;
  subjectId?: string;
  evidenceLayer?: EvidenceLayer;
  suiteId?: string;
  outcome?: string;
  excluded: boolean;
  exclusionReason: string | null;
  [key: string]: unknown;
};

export type ArtifactMetadataDto = {
  digest: string;
  artifactClass: string | null;
  mediaType: string | null;
  byteCount: number | null;
  status: "present" | "corrupt" | "purged_unavailable";
  lastError: string | null;
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

export type PaginatedObservations = {
  observations: ObservationDto[];
  hasMore: boolean;
  nextCursor?: string;
};

export type PaginatedEvents = {
  events: EventListItemDto[];
  hasMore: boolean;
  nextCursor?: string;
};

export type MatrixRow = {
  subjectId: string;
  subjectKind: string;
  byLayer: Record<EvidenceLayer, VerdictDto[]>;
};

/** UI filter state; subjectQuery maps to the API subjectId param when refetching. */
export type VerdictFilters = {
  layer: EvidenceLayer | "";
  verdict: CompatibilityVerdict | "";
  subjectQuery: string;
  suiteId: string;
};

export type VerdictQueryFilters = {
  layer?: EvidenceLayer;
  verdict?: CompatibilityVerdict;
  subjectId?: string;
  suiteId?: string;
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

export function parseSubjectDetail(raw: unknown): SubjectDetailDto | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.subject)) return null;
  const subject = raw.subject;
  if (typeof subject.subjectKind !== "string") return null;
  return subject as SubjectDetailDto;
}

export function parseObservationDto(raw: unknown): ObservationDto | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.eventId !== "string") return null;
  if (typeof raw.subjectId !== "string") return null;
  if (typeof raw.evidenceLayer !== "string") return null;
  if (!EVIDENCE_LAYERS.includes(raw.evidenceLayer as EvidenceLayer)) return null;
  if (typeof raw.suiteId !== "string") return null;
  if (typeof raw.outcome !== "string") return null;
  return raw as ObservationDto;
}

export function parseObservationsPage(raw: unknown): PaginatedObservations {
  if (!isPlainObject(raw) || !Array.isArray(raw.observations)) {
    return { observations: [], hasMore: false };
  }
  const observations = raw.observations
    .map(parseObservationDto)
    .filter((row): row is ObservationDto => row !== null);
  return {
    observations,
    hasMore: raw.hasMore === true,
    nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
  };
}

export function parseEventListItem(raw: unknown): EventListItemDto | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.eventId !== "string") return null;
  if (typeof raw.eventKind !== "string") return null;
  return raw as EventListItemDto;
}

export function parseEventsPage(raw: unknown): PaginatedEvents {
  if (!isPlainObject(raw) || !Array.isArray(raw.events)) {
    return { events: [], hasMore: false };
  }
  const events = raw.events
    .map(parseEventListItem)
    .filter((row): row is EventListItemDto => row !== null);
  return {
    events,
    hasMore: raw.hasMore === true,
    nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : undefined,
  };
}

export function parseLabEvent(raw: unknown): LabEventDto | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.event)) return null;
  const event = { ...raw.event };
  delete event.payload_json;
  if (typeof event.eventKind !== "string") return null;
  if (typeof event.eventId !== "string") return null;
  return event as LabEventDto;
}

export function parseArtifactMetadata(raw: unknown): ArtifactMetadataDto | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.artifact)) return null;
  const artifact = raw.artifact;
  if (typeof artifact.digest !== "string") return null;
  if (typeof artifact.status !== "string") return null;
  return artifact as ArtifactMetadataDto;
}

export function verdictQueryFromFilters(filters: VerdictFilters): VerdictQueryFilters {
  const query: VerdictQueryFilters = {};
  const subjectId = filters.subjectQuery.trim();
  if (filters.layer) query.layer = filters.layer;
  if (filters.verdict) query.verdict = filters.verdict;
  if (subjectId) query.subjectId = subjectId;
  if (filters.suiteId.trim()) query.suiteId = filters.suiteId.trim();
  return query;
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
    if (filters.suiteId && verdict.suiteId !== filters.suiteId) return false;
    if (query && !verdict.subjectId.toLowerCase().includes(query)) return false;
    return true;
  });
}

export function shortSubjectId(subjectId: string): string {
  if (subjectId.length <= 16) return subjectId;
  return `${subjectId.slice(0, 8)}.${subjectId.slice(-6)}`;
}

export function formatAsOf(ms: number, locale: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return new Date(ms).toLocaleString(locale);
}

export function artifactDigestsForVerdict(verdict: VerdictDto): string[] {
  const digests = new Set<string>();
  digests.add(verdict.suiteManifestDigest);
  for (const digest of verdict.scenarioManifestDigests) digests.add(digest);
  if (verdict.claimSourceDigest) digests.add(verdict.claimSourceDigest);
  return [...digests];
}
