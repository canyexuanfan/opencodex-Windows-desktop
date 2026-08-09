import { readJsonOrThrow } from "../fetch-json";
import {
  parseLabStatus,
  parseSubjectPage,
  parseVerdictPage,
  type LabStatusDto,
  type PaginatedSubjects,
  type VerdictDto,
} from "./compatibility-matrix-shared";
const PAGE_LIMIT = 100;

async function fetchLabJson<T>(
  apiBase: string,
  path: string,
  signal: AbortSignal,
): Promise<T | undefined> {
  const res = await fetch(`${apiBase}${path}`, { signal });
  return readJsonOrThrow<T>(res);
}

export async function fetchLabStatus(
  apiBase: string,
  signal: AbortSignal,
): Promise<LabStatusDto> {
  const raw = await fetchLabJson<unknown>(apiBase, "/api/lab/status", signal);
  return parseLabStatus(raw) ?? { projectionAvailable: false };
}

export async function fetchAllVerdicts(
  apiBase: string,
  signal: AbortSignal,
): Promise<VerdictDto[]> {
  const rows: VerdictDto[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) query.set("cursor", cursor);
    const raw = await fetchLabJson<unknown>(apiBase, `/api/lab/verdicts?${query}`, signal);
    const page = parseVerdictPage(raw);
    rows.push(...page.verdicts);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  return rows;
}

export async function fetchAllSubjects(
  apiBase: string,
  signal: AbortSignal,
): Promise<PaginatedSubjects["subjects"]> {
  const rows: PaginatedSubjects["subjects"] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) query.set("cursor", cursor);
    const raw = await fetchLabJson<unknown>(apiBase, `/api/lab/subjects?${query}`, signal);
    const page = parseSubjectPage(raw);
    rows.push(...page.subjects);
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor);
  return rows;
}

export type LabPageData = {
  status: LabStatusDto;
  verdicts: VerdictDto[];
  subjects: PaginatedSubjects["subjects"];
};

export async function fetchLabPageData(
  apiBase: string,
  signal: AbortSignal,
): Promise<LabPageData> {
  const status = await fetchLabStatus(apiBase, signal);
  if (!status.projectionAvailable) {
    return { status, verdicts: [], subjects: [] };
  }
  const [verdicts, subjects] = await Promise.all([
    fetchAllVerdicts(apiBase, signal),
    fetchAllSubjects(apiBase, signal),
  ]);
  return { status, verdicts, subjects };
}
