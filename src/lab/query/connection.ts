import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import { labSqlitePath } from "../paths";
import { LAB_SQLITE_SCHEMA_VERSION } from "../projection/schema";
import { LabProjectionIncompatibleError, LabProjectionUnavailableError } from "./errors";

export interface LabReadConnection {
  db: Database;
  sqlitePath: string;
  schemaVersion: number;
  projectionSpecVersion: string;
  builtAtMs: number;
}

export function resolveLabSqlitePath(configDir?: string): string {
  return labSqlitePath(configDir);
}

export function openLabReadConnection(configDir?: string): LabReadConnection {
  const sqlitePath = resolveLabSqlitePath(configDir);
  if (!existsSync(sqlitePath)) {
    throw new LabProjectionUnavailableError();
  }
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const metaRows = db
      .query("SELECT key, value FROM schema_meta")
      .all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((r) => [r.key, r.value]));
    const schemaRaw = meta.get("schema_version");
    const specRaw = meta.get("projection_spec_version");
    const builtRaw = meta.get("built_at_ms");
    if (!schemaRaw || !specRaw || !builtRaw) {
      db.close();
      throw new LabProjectionUnavailableError();
    }
    const schemaVersion = Number(schemaRaw);
    const projectionSpecVersion = specRaw;
    const builtAtMs = Number(builtRaw);
    if (
      !Number.isInteger(schemaVersion) ||
      schemaVersion !== LAB_SQLITE_SCHEMA_VERSION ||
      projectionSpecVersion !== LAB_PROJECTION_SPEC_VERSION ||
      !Number.isFinite(builtAtMs)
    ) {
      db.close();
      throw new LabProjectionIncompatibleError();
    }
    return {
      db,
      sqlitePath,
      schemaVersion,
      projectionSpecVersion,
      builtAtMs,
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    if (err instanceof LabProjectionUnavailableError || err instanceof LabProjectionIncompatibleError) {
      throw err;
    }
    throw new LabProjectionUnavailableError();
  }
}

export function closeLabReadConnection(conn: LabReadConnection): void {
  conn.db.close();
}

export function countTable(conn: LabReadConnection, table: string): number {
  const row = conn.db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return Number(row.c);
}
