import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { jcsStringify } from "../digest";
import type { LabEvent, LedgerCorruption, ReplayResult } from "../events/types";
import { LabValidationError, validateLabEvent } from "../events/validate";
import { ensureLabDirs, labLedgerPath } from "../paths";

export interface LedgerStore {
  path: string;
  append(event: LabEvent): void;
  replay(): ReplayResult;
}

/** Durable append of one validated event as a single JSONL line + fsync. */
export function appendLabEvent(ledgerPath: string, event: LabEvent): void {
  const validated = validateLabEvent(event);
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const line = `${jcsStringify(validated)}\n`;
  const bytes = new TextEncoder().encode(line);
  const fd = openSync(ledgerPath, "a", 0o600);
  try {
    const written = writeSync(fd, bytes);
    if (written !== bytes.byteLength) {
      throw new LabValidationError("short_write", "ledger append short write");
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replay the JSONL ledger.
 * Malformed or partial lines contribute no evidence and are reported as corruption.
 */
export function replayLabLedger(ledgerPath: string): ReplayResult {
  const corruptions: LedgerCorruption[] = [];
  const events: LabEvent[] = [];
  if (!existsSync(ledgerPath)) {
    return { events, corruptions, validLineCount: 0, totalLineCount: 0 };
  }
  const text = readFileSync(ledgerPath, "utf8");
  if (text.length === 0) {
    return {
      events,
      corruptions: [{ kind: "empty_ledger", detail: "ledger file is empty" }],
      validLineCount: 0,
      totalLineCount: 0,
    };
  }

  const hasTrailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  // split yields a trailing empty string when file ends with \n
  if (hasTrailingNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const seenIds = new Set<string>();
  let totalLineCount = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const line = rawLines[i]!;
    totalLineCount += 1;

    // Partial final line: file does not end with newline
    if (!hasTrailingNewline && i === rawLines.length - 1) {
      corruptions.push({
        kind: "partial_line",
        lineNumber,
        detail: "partial final JSONL line (missing trailing newline)",
      });
      continue;
    }

    if (line.trim() === "") {
      corruptions.push({ kind: "malformed_line", lineNumber, detail: "empty line" });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruptions.push({ kind: "malformed_line", lineNumber, detail: "JSON parse failed" });
      continue;
    }

    let event: LabEvent;
    try {
      event = validateLabEvent(parsed);
    } catch (err) {
      corruptions.push({
        kind: "invalid_event",
        lineNumber,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (seenIds.has(event.eventId)) {
      corruptions.push({
        kind: "duplicate_event",
        lineNumber,
        eventId: event.eventId,
        detail: "duplicate eventId",
      });
      continue;
    }
    seenIds.add(event.eventId);
    events.push(event);
  }

  return {
    events,
    corruptions,
    validLineCount: events.length,
    totalLineCount,
  };
}

export function openLedgerStore(configDir?: string): LedgerStore {
  const paths = ensureLabDirs(configDir);
  return {
    path: paths.ledgerPath,
    append(event: LabEvent) {
      appendLabEvent(paths.ledgerPath, event);
    },
    replay() {
      return replayLabLedger(paths.ledgerPath);
    },
  };
}

export function defaultLedgerPath(configDir?: string): string {
  return labLedgerPath(configDir);
}
