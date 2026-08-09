import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
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

function processLine(
  line: string,
  lineNumber: number,
  hasTrailingNewline: boolean,
  isLastBufferedLine: boolean,
  events: LabEvent[],
  seenIds: Set<string>,
  corruptions: LedgerCorruption[],
): void {
  if (!hasTrailingNewline && isLastBufferedLine) {
    corruptions.push({
      kind: "partial_line",
      lineNumber,
      detail: "partial final JSONL line (missing trailing newline)",
    });
    return;
  }
  if (line.trim() === "") {
    corruptions.push({ kind: "malformed_line", lineNumber, detail: "empty line" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    corruptions.push({ kind: "malformed_line", lineNumber, detail: "JSON parse failed" });
    return;
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
    return;
  }

  if (seenIds.has(event.eventId)) {
    corruptions.push({
      kind: "duplicate_event",
      lineNumber,
      eventId: event.eventId,
      detail: "duplicate eventId",
    });
    return;
  }
  seenIds.add(event.eventId);
  events.push(event);
}

/**
 * Replay the JSONL ledger using chunked reads (no whole-file string buffer).
 * Malformed or partial lines contribute no evidence and are reported as corruption.
 */
export function replayLabLedger(ledgerPath: string): ReplayResult {
  const corruptions: LedgerCorruption[] = [];
  const events: LabEvent[] = [];
  if (!existsSync(ledgerPath)) {
    return { events, corruptions, validLineCount: 0, totalLineCount: 0 };
  }
  const size = statSync(ledgerPath).size;
  if (size === 0) {
    return {
      events,
      corruptions: [{ kind: "empty_ledger", detail: "ledger file is empty" }],
      validLineCount: 0,
      totalLineCount: 0,
    };
  }

  const fd = openSync(ledgerPath, "r");
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  let carry = "";
  let lineNumber = 0;
  let totalLineCount = 0;
  const seenIds = new Set<string>();
  let offset = 0;
  let hasTrailingNewline = false;

  try {
    while (offset < size) {
      const toRead = Math.min(chunkSize, size - offset);
      const n = readSync(fd, chunk, 0, toRead, offset);
      if (n <= 0) break;
      offset += n;
      carry += chunk.toString("utf8", 0, n);
      let idx = carry.indexOf("\n");
      while (idx >= 0) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        lineNumber += 1;
        totalLineCount += 1;
        hasTrailingNewline = true;
        processLine(line, lineNumber, true, false, events, seenIds, corruptions);
        idx = carry.indexOf("\n");
      }
    }

    if (carry.length > 0) {
      lineNumber += 1;
      totalLineCount += 1;
      processLine(carry, lineNumber, hasTrailingNewline, true, events, seenIds, corruptions);
    }
  } finally {
    closeSync(fd);
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
