import { parseCockpitAccountDocument } from "./parser";
import { resolveAccountImportAdapter, type AccountImportRegistryResult } from "./registry";
import type {
  AccountImportRequest,
  AccountImportResult,
  AccountImportRecordResult,
} from "./types";

export type AccountImportServiceResult =
  | { ok: true; result: AccountImportResult }
  | {
    ok: false;
    status: 400;
    code: "unsupported_provider" | "unsupported_format" | "invalid_document";
  };

export interface AccountImportServiceDeps {
  resolveAdapter(provider: string, format: string): AccountImportRegistryResult;
}

export async function importAccounts(
  request: AccountImportRequest,
  deps: AccountImportServiceDeps = { resolveAdapter: resolveAccountImportAdapter },
): Promise<AccountImportServiceResult> {
  // Provider/format admission intentionally precedes any traversal or serialization of the
  // credential-bearing document.
  const resolved = deps.resolveAdapter(request.provider, request.format);
  if (!resolved.ok) return { ok: false, status: 400, code: resolved.code };

  const parsed = parseCockpitAccountDocument(request.document);
  if (!parsed.ok) return { ok: false, status: 400, code: parsed.code };

  const results: AccountImportRecordResult[] = [];
  for (const item of parsed.records) {
    if ("code" in item) {
      results.push({ index: item.index, status: "failed", code: item.code });
      continue;
    }
    const outcome = await resolved.adapter.importRecord(item.record);
    results.push({ index: item.index, ...outcome });
  }

  const count = (status: AccountImportRecordResult["status"]) =>
    results.filter(result => result.status === status).length;
  return {
    ok: true,
    result: {
      totalCount: results.length,
      importedCount: count("imported"),
      updatedCount: count("updated"),
      failedCount: count("failed"),
      unsupportedCount: count("unsupported"),
      results,
    },
  };
}
