export const MAX_CLIENT_SSE_FRAME_BYTES = 4 * 1024 * 1024;

export class SseFrameTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upstream SSE frame exceeded ${maxBytes} bytes`);
    this.name = "SseFrameTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export type BoundedSseFrame = {
  block: Uint8Array;
  delimiter: Uint8Array;
};

function delimiterLengthAt(
  index: number,
  length: number,
  byteAt: (index: number) => number,
): number | 0 | undefined {
  const first = byteAt(index);
  if (first === 10) {
    if (index + 1 >= length) return undefined;
    const second = byteAt(index + 1);
    if (second === 10) return 2;
    if (second !== 13) return 0;
    if (index + 2 >= length) return undefined;
    return byteAt(index + 2) === 10 ? 3 : 0;
  }
  if (first !== 13) return 0;
  if (index + 1 >= length) return undefined;
  if (byteAt(index + 1) !== 10) return 0;
  if (index + 2 >= length) return undefined;
  const third = byteAt(index + 2);
  if (third === 10) return 3;
  if (third !== 13) return 0;
  if (index + 3 >= length) return undefined;
  return byteAt(index + 3) === 10 ? 4 : 0;
}

function joinSlices(slices: readonly Uint8Array[], byteLength: number): Uint8Array {
  if (byteLength === 0) return new Uint8Array(0);
  if (slices.length === 1 && slices[0]!.byteLength === byteLength) return slices[0]!;
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const slice of slices) {
    joined.set(slice, offset);
    offset += slice.byteLength;
  }
  return joined;
}

function copyRange(
  start: number,
  end: number,
  tailLength: number,
  previousTail: Uint8Array,
  chunk: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(end - start);
  for (let index = start; index < end; index += 1) {
    out[index - start] = index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;
  }
  return out;
}

/**
 * Byte-bounded SSE block framer for client-facing protocol paths.
 *
 * The delimiter scanner works on raw bytes, so fragmented UTF-8 cannot change
 * accounting and a hostile upstream cannot grow an unterminated JS string
 * without limit. Complete blocks are returned without their delimiter; the
 * exact delimiter bytes are returned separately so callers can relay bytes
 * unchanged.
 */
export class BoundedSseFrameBuffer {
  private readonly maxFrameBytes: number;
  private delimiterTail: Uint8Array = new Uint8Array(0);
  private candidateSlices: Uint8Array[] = [];
  private candidateBytes = 0;
  private disposed = false;

  constructor(maxFrameBytes = MAX_CLIENT_SSE_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.maxFrameBytes = maxFrameBytes;
  }

  private clear(): void {
    this.delimiterTail = new Uint8Array(0);
    this.candidateSlices = [];
    this.candidateBytes = 0;
  }

  private retain(slice: Uint8Array): void {
    if (slice.byteLength === 0) return;
    const nextBytes = this.candidateBytes + slice.byteLength;
    if (nextBytes > this.maxFrameBytes) {
      this.clear();
      this.disposed = true;
      throw new SseFrameTooLargeError(this.maxFrameBytes);
    }
    // Never retain a view into an arbitrarily larger fetch chunk.
    this.candidateSlices.push(slice.slice());
    this.candidateBytes = nextBytes;
  }

  feed(chunk: Uint8Array): BoundedSseFrame[] {
    if (this.disposed) return [];
    if (chunk.byteLength === 0) return [];

    const frames: BoundedSseFrame[] = [];
    const previousTail = this.delimiterTail;
    this.delimiterTail = new Uint8Array(0);
    const tailLength = previousTail.byteLength;
    const totalLength = tailLength + chunk.byteLength;
    const byteAt = (index: number): number => index < tailLength
      ? previousTail[index]!
      : chunk[index - tailLength]!;
    const retainRange = (start: number, end: number): void => {
      if (end <= start) return;
      if (start < tailLength) {
        this.retain(previousTail.subarray(start, Math.min(end, tailLength)));
      }
      if (end > tailLength) {
        this.retain(chunk.subarray(Math.max(0, start - tailLength), end - tailLength));
      }
    };

    let index = 0;
    let retainedThrough = 0;
    while (index < totalLength) {
      const delimiterLength = delimiterLengthAt(index, totalLength, byteAt);
      if (delimiterLength === undefined) break;
      if (delimiterLength > 0) {
        retainRange(retainedThrough, index);
        const block = joinSlices(this.candidateSlices, this.candidateBytes);
        this.candidateSlices = [];
        this.candidateBytes = 0;
        const delimiter = copyRange(
          index,
          index + delimiterLength,
          tailLength,
          previousTail,
          chunk,
        );
        frames.push({ block, delimiter });
        index += delimiterLength;
        retainedThrough = index;
        continue;
      }
      index += 1;
    }

    retainRange(retainedThrough, index);
    if (index < totalLength) {
      this.delimiterTail = copyRange(index, totalLength, tailLength, previousTail, chunk);
    }
    return frames;
  }

  /** Return the final unterminated block bytes and release all retained state. */
  finish(): Uint8Array {
    if (this.disposed) return new Uint8Array(0);
    try {
      this.retain(this.delimiterTail);
      this.delimiterTail = new Uint8Array(0);
      return joinSlices(this.candidateSlices, this.candidateBytes);
    } finally {
      this.clear();
      this.disposed = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }
}

export function joinSseFrameBytes(parts: readonly Uint8Array[]): Uint8Array {
  let byteLength = 0;
  for (const part of parts) byteLength += part.byteLength;
  return joinSlices(parts, byteLength);
}
