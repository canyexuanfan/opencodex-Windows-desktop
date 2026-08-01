import {
  TRANSLATOR_MAX_SSE_EVENT_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "./translator-budget";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export type SseRecord =
  | { kind: "event"; event?: string; data: string }
  | { kind: "comment"; comment: string };

/**
 * Decode text/event-stream records across arbitrary fetch chunk boundaries.
 *
 * The final record is dispatched at EOF even when the upstream omits the trailing blank line or
 * final newline. That matters for compatible APIs that place a terminal event in the last bytes of
 * the body: dropping that record turns a successful response into an adapter_eof failure.
 */
export function decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: { includeComments: true; signal?: AbortSignal; translatorBudget: TranslatorBudget },
): AsyncGenerator<SseRecord>;
export function decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: { includeComments?: false; signal?: AbortSignal; translatorBudget: TranslatorBudget },
): AsyncGenerator<ServerSentEvent>;
export async function* decodeServerSentEvents(
  source: ReadableStream<Uint8Array>,
  options: { includeComments?: boolean; signal?: AbortSignal; translatorBudget: TranslatorBudget },
): AsyncGenerator<ServerSentEvent | SseRecord> {
  const translatorBudget = options.translatorBudget;
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const budgetEncoder = new TextEncoder();
  let lineBuffer = "";
  let lineRawBytes = 0;
  let lineRetainedBytes = 0;
  let event: string | undefined;
  let eventBytes = 0;
  let dataLines: string[] = [];
  let dataLinesBytes = 0;
  const scope = { kind: "live_transient" as const };

  const utf8SliceBytes = (value: string, start: number, end: number): number => {
    let bytes = 0;
    for (let index = start; index < end; index++) {
      const codePoint = value.codePointAt(index)!;
      if (codePoint <= 0x7f) bytes += 1;
      else if (codePoint <= 0x7ff) bytes += 2;
      else if (codePoint <= 0xffff) bytes += 3;
      else {
        bytes += 4;
        index += 1;
      }
    }
    return bytes;
  };

  const linePrefixAfter = (sourceValue: string, start: number, end: number): string => {
    if (lineBuffer.length >= 6) return lineBuffer.slice(0, 6);
    return (lineBuffer + sourceValue.slice(start, Math.min(end, start + 6 - lineBuffer.length))).slice(0, 6);
  };

  const accountedLineBytes = (rawBytes: number, prefix: string): number => {
    if (prefix.length < 5 && "data:".startsWith(prefix)) return 0;
    if (!prefix.startsWith("data:")) return rawBytes;
    return Math.max(0, rawBytes - (prefix[5] === " " ? 6 : 5));
  };

  const appendLine = (sourceValue: string, start: number, end: number): void => {
    if (start >= end) return;
    const nextRawBytes = lineRawBytes + utf8SliceBytes(sourceValue, start, end);
    const prefix = linePrefixAfter(sourceValue, start, end);
    const nextRetainedBytes = accountedLineBytes(nextRawBytes, prefix);
    if (prefix.startsWith("data:")) {
      const logicalEventBytes = dataLinesBytes + dataLines.length + nextRetainedBytes;
      if (logicalEventBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
        throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
      }
    }
    const reservation = translatorBudget.reserveTransient(nextRetainedBytes, scope);
    try {
      const fragment = sourceValue.slice(start, end);
      lineBuffer += fragment;
      reservation.commitRetained();
      translatorBudget.releaseRetained(lineRetainedBytes, scope);
      lineRawBytes = nextRawBytes;
      lineRetainedBytes = nextRetainedBytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };
  // Prompt cancellation channel: an abort cancels the underlying reader directly, which
  // settles any in-flight read() so a consumer's iterator.return() cannot hang behind an
  // idle upstream (a plain generator return waits for the pending await first).
  const signal = options?.signal;
  const onAbort = () => { reader.cancel(signal?.reason).catch(() => { /* already closed */ }); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const includeComments = options?.includeComments === true;

  const dispatch = (): { record: ServerSentEvent | SseRecord; bytes: number } | undefined => {
    if (dataLines.length === 0) {
      translatorBudget.releaseRetained(eventBytes, scope);
      event = undefined;
      eventBytes = 0;
      return undefined;
    }
    const payloadBytes = dataLinesBytes + Math.max(0, dataLines.length - 1);
    if (payloadBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
      throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
    }
    let data: string;
    if (dataLines.length === 1) {
      data = dataLines[0]!;
    } else {
      const reservation = translatorBudget.reserveTransient(payloadBytes, scope);
      try {
        data = dataLines.join("\n");
        reservation.commitRetained();
        translatorBudget.releaseRetained(dataLinesBytes, scope);
      } catch (error) {
        reservation.release();
        throw error;
      }
    }
    const record = { ...(event ? { event } : {}), data };
    const retainedRecordBytes = payloadBytes + eventBytes;
    event = undefined;
    eventBytes = 0;
    dataLines = [];
    dataLinesBytes = 0;
    return {
      record: includeComments ? { kind: "event", ...record } : record,
      bytes: retainedRecordBytes,
    };
  };

  const acceptLine = (): { record: ServerSentEvent | SseRecord; bytes: number } | undefined => {
    const line = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
    const retainedLineBytes = lineRetainedBytes;
    lineBuffer = "";
    lineRawBytes = 0;
    lineRetainedBytes = 0;
    if (line === "") {
      translatorBudget.releaseRetained(retainedLineBytes, scope);
      return dispatch();
    }
    if (line.startsWith(":")) {
      if (!includeComments) {
        translatorBudget.releaseRetained(retainedLineBytes, scope);
        return undefined;
      }
      let comment = line.slice(1);
      if (comment.startsWith(" ")) comment = comment.slice(1);
      return { record: { kind: "comment", comment }, bytes: retainedLineBytes };
    }

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      const valueBytes = budgetEncoder.encode(value).byteLength;
      const reservation = translatorBudget.reserveTransient(valueBytes, scope);
      reservation.commitRetained();
      translatorBudget.releaseRetained(eventBytes + retainedLineBytes, scope);
      event = value;
      eventBytes = valueBytes;
    }
    else if (field === "data") {
      const valueBytes = budgetEncoder.encode(value).byteLength;
      const nextEventBytes = dataLinesBytes + valueBytes + dataLines.length;
      if (nextEventBytes > TRANSLATOR_MAX_SSE_EVENT_BYTES) {
        throw new TranslatorBudgetExceededError("live_transient", TRANSLATOR_MAX_SSE_EVENT_BYTES);
      }
      // The admitted line allocation transfers to the extracted data value. No second
      // physical owner is retained after this function returns.
      dataLines.push(value);
      dataLinesBytes += valueBytes;
      if (retainedLineBytes > valueBytes) {
        translatorBudget.releaseRetained(retainedLineBytes - valueBytes, scope);
      }
    } else {
      translatorBudget.releaseRetained(retainedLineBytes, scope);
    }
    return undefined;
  };

  const consumeDecoded = async function* (
    decoded: string,
  ): AsyncGenerator<ServerSentEvent | SseRecord> {
    let offset = 0;
    while (offset < decoded.length) {
      const newline = decoded.indexOf("\n", offset);
      if (newline < 0) {
        appendLine(decoded, offset, decoded.length);
        return;
      }
      appendLine(decoded, offset, newline);
      const accepted = acceptLine();
      if (accepted) {
        try {
          yield accepted.record;
        } finally {
          translatorBudget.releaseRetained(accepted.bytes, scope);
        }
      }
      offset = newline + 1;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        const decoded = decoder.decode(value, { stream: !done });
        yield* consumeDecoded(decoded);
      }
      if (!done) continue;
      const finalDecoded = decoder.decode();
      yield* consumeDecoded(finalDecoded);
      if (lineBuffer.length > 0) {
        const accepted = acceptLine();
        if (accepted) {
          try {
            yield accepted.record;
          } finally {
            translatorBudget.releaseRetained(accepted.bytes, scope);
          }
        }
      }
      const finalRecord = dispatch();
      if (finalRecord) {
        try {
          yield finalRecord.record;
        } finally {
          translatorBudget.releaseRetained(finalRecord.bytes, scope);
        }
      }
      break;
    }
  } finally {
    translatorBudget.releaseRetained(lineRetainedBytes + dataLinesBytes + eventBytes, scope);
    signal?.removeEventListener("abort", onAbort);
    try { await reader.cancel(); } catch { /* already closed/errored */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
