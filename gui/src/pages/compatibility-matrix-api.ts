import { readJsonOrThrow } from "../fetch-json";
import {
  artifactDigestsForVerdict,
  parseArtifactMetadata,
  parseLabEvent,
  parseLabStatus,
  parseObservationsPage,
  parseSubjectDetail,
  parseSubjectPage,
  parseVerdictPage,
  type ArtifactMetadataDto,
  type LabEventDto,
  type LabStatusDto,
  type ObservationDto,
  type PaginatedObservations,
  type PaginatedSubjects,
  type PaginatedVerdicts,
  type SubjectDetailDto,
  type SubjectListItemDto,
  type VerdictDto,
  type VerdictQueryFilters,
} from "./compatibility-matrix-shared";

const PAGE_LIMIT = 50;

async function fetchLabJson<T>(
  apiBase: string,
  path: string,
  signal: AbortSignal,
): Promise<T | undefined> {
  const res = await fetch(`${apiBase}${path}`, { signal });
  return readJsonOrThrow<T>(res);
}

function buildQuery(
  params: Record<string, string | undefined>,
  cursor?: string,
): string {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export async function fetchLabStatus(
  apiBase: string,
  signal: AbortSignal,
): Promise<LabStatusDto> {
  const raw = await fetchLabJson<unknown>(apiBase, "/api/lab/status", signal);
  return parseLabStatus(raw) ?? { projectionAvailable: false };
}

export async function fetchVerdictPage(
  apiBase: string,
  filters: VerdictQueryFilters,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PaginatedVerdicts> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/verdicts?${buildQuery({
      layer: filters.layer,
      verdict: filters.verdict,
      subjectId: filters.subjectId,
      suiteId: filters.suiteId,
    }, cursor)}`,
    signal,
  );
  return parseVerdictPage(raw);
}

export async function fetchSubjectPage(
  apiBase: string,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PaginatedSubjects> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/subjects?${buildQuery({}, cursor)}`,
    signal,
  );
  return parseSubjectPage(raw);
}

export async function fetchAllSubjects(
  apiBase: string,
  signal: AbortSignal,
): Promise<SubjectListItemDto[]> {
  const rows: SubjectListItemDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchSubjectPage(apiBase, cursor, signal);
    rows.push(...page.subjects);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  return rows;
}

export async function fetchSubjectDetail(
  apiBase: string,
  subjectId: string,
  signal: AbortSignal,
): Promise<SubjectDetailDto | null> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/subjects/${encodeURIComponent(subjectId)}`,
    signal,
  );
  return parseSubjectDetail(raw);
}

export async function fetchObservationsPage(
  apiBase: string,
  filters: { subjectId: string; layer?: string; suiteId?: string },
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PaginatedObservations> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/observations?${buildQuery({
      subjectId: filters.subjectId,
      layer: filters.layer,
      suiteId: filters.suiteId,
    }, cursor)}`,
    signal,
  );
  return parseObservationsPage(raw);
}

export async function fetchEventById(
  apiBase: string,
  eventId: string,
  signal: AbortSignal,
): Promise<LabEventDto | null> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/events/${encodeURIComponent(eventId)}`,
    signal,
  );
  return parseLabEvent(raw);
}

export async function fetchArtifactByDigest(
  apiBase: string,
  digest: string,
  signal: AbortSignal,
): Promise<ArtifactMetadataDto | null> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/artifacts/${encodeURIComponent(digest)}`,
    signal,
  );
  return parseArtifactMetadata(raw);
}

export type LabPageData = {
  status: LabStatusDto;
  verdicts: VerdictDto[];
  subjects: SubjectListItemDto[];
  hasMore: boolean;
  nextCursor?: string;
};

export async function fetchLabPageData(
  apiBase: string,
  filters: VerdictQueryFilters,
  signal: AbortSignal,
): Promise<LabPageData> {
  const status = await fetchLabStatus(apiBase, signal);
  if (!status.projectionAvailable) {
    return { status, verdicts: [], subjects: [], hasMore: false };
  }
  const [verdictPage, subjects] = await Promise.all([
    fetchVerdictPage(apiBase, filters, undefined, signal),
    fetchAllSubjects(apiBase, signal),
  ]);
  return {
    status,
    verdicts: verdictPage.verdicts,
    subjects,
    hasMore: verdictPage.hasMore,
    nextCursor: verdictPage.nextCursor,
  };
}

export async function fetchMoreVerdicts(
  apiBase: string,
  filters: VerdictQueryFilters,
  cursor: string,
  signal: AbortSignal,
): Promise<PaginatedVerdicts> {
  return fetchVerdictPage(apiBase, filters, cursor, signal);
}

export type VerdictDetailData = {
  subject: SubjectDetailDto | null;
  observations: ObservationDto[];
  events: LabEventDto[];
  artifacts: ArtifactMetadataDto[];
};

export async function fetchVerdictDetail(
  apiBase: string,
  verdict: VerdictDto,
  signal: AbortSignal,
): Promise<VerdictDetailData> {
  const eventIds = [...verdict.contributingEventIds, ...verdict.contradictingEventIds];
  const [subject, observationsPage, ...rest] = await Promise.all([
    fetchSubjectDetail(apiBase, verdict.subjectId, signal),
    fetchObservationsPage(apiBase, {
      subjectId: verdict.subjectId,
      layer: verdict.evidenceLayer,
      suiteId: verdict.suiteId,
    }, undefined, signal),
    ...eventIds.map(id => fetchEventById(apiBase, id, signal)),
    ...artifactDigestsForVerdict(verdict).map(digest => fetchArtifactByDigest(apiBase, digest, signal)),
  ]);
  const events = rest.slice(0, eventIds.length).filter((row): row is LabEventDto => row !== null);
  const artifacts = rest.slice(eventIds.length).filter((row): row is ArtifactMetadataDto => row !== null);
  return {
    subject,
    observations: observationsPage.observations,
    events,
    artifacts,
  };
}
