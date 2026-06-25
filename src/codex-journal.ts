import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./config";
import { CODEX_HOME, CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "./codex-paths";

const JOURNAL_PATH = join(CODEX_HOME, "opencodex-journal.json");

interface Journal {
  version: 1;
  originalConfig: string;
  originalProfile: string | null;
  pid: number;
  timestamp: string;
}

export function writeJournal(): void {
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  const config = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const profile = existsSync(CODEX_PROFILE_PATH)
    ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
    : null;
  const journal: Journal = {
    version: 1,
    originalConfig: Buffer.from(config).toString("base64"),
    originalProfile: profile ? Buffer.from(profile).toString("base64") : null,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  atomicWriteFile(JOURNAL_PATH, JSON.stringify(journal));
}

export function removeJournal(): void {
  try { unlinkSync(JOURNAL_PATH); } catch { /* ignore */ }
}

export function reconcileJournal(): boolean {
  if (!existsSync(JOURNAL_PATH)) return false;
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
    if (journal.version !== 1) throw new Error("unknown version");
  } catch {
    removeJournal();
    return false;
  }
  try {
    process.kill(journal.pid, 0);
    return false;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
  }
  atomicWriteFile(CODEX_CONFIG_PATH, Buffer.from(journal.originalConfig, "base64").toString("utf-8"));
  if (journal.originalProfile !== null) {
    atomicWriteFile(CODEX_PROFILE_PATH, Buffer.from(journal.originalProfile, "base64").toString("utf-8"));
  } else if (existsSync(CODEX_PROFILE_PATH)) {
    try { unlinkSync(CODEX_PROFILE_PATH); } catch { /* ignore */ }
  }
  removeJournal();
  console.error(`⚠️  Previous session (PID ${journal.pid}) did not shut down cleanly. Codex config restored from journal.`);
  return true;
}
