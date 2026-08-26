/**
 * Tool-result envelope echo detection for external full-replay continuations
 * (devlog 260826 gap-10).
 *
 * External models receive prior tool results as flattened assistant-role text
 * ("[Tool Result]\n[tool_result]\ncall_id: ..."). Mimicking models (kimi-k3
 * observed at ~30-40% of multi-round probes) sometimes ECHO that envelope as
 * their own reply instead of continuing the task. A prompt-side guard note did
 * not reduce the rate, so the boundary is observation: quarantine the first
 * bytes of assistant text until they provably diverge from the markers, and
 * classify a completed marker as a retryable semantic failure.
 */

const ECHO_MARKERS = ["[Tool Result]", "[Tool Error]", "[tool_result]"] as const;
const MAX_SNIFF_BYTES = 40;
/** Aggregate quarantine cap: past this, flush and disarm (never a marker at this size). */
const MAX_HOLD_BYTES = 8 * 1024;
const encoder = new TextEncoder();

export class CursorToolResultEchoError extends Error {
  readonly code = "cursor_tool_result_echo";
  constructor(marker: string) {
    super(
      `Cursor external model echoed the replayed tool-result envelope ("${marker}") instead of continuing the task.`,
    );
    this.name = "CursorToolResultEchoError";
  }
}

export type EchoSnifferDecision =
  | { kind: "hold" }
  | { kind: "flush" }
  | { kind: "echo"; marker: string };

/**
 * Incremental prefix sniffer. Feed assistant text deltas in order; it answers
 * hold (still ambiguous), flush (provably not an echo — release everything and
 * disarm), or echo (a marker completed at the start of the reply).
 *
 * Leading whitespace (bounded by MAX_SNIFF_BYTES) is tolerated before the
 * marker, matching how models reproduce the envelope after a newline.
 */
export class CursorEnvelopeEchoSniffer {
  private buffered = "";
  private byteCount = 0;
  private done = false;

  /** True once the sniffer reached a terminal decision (flush or echo). */
  get settled(): boolean {
    return this.done;
  }

  feed(textDelta: string): EchoSnifferDecision {
    if (this.done) return { kind: "flush" };
    this.buffered += textDelta;
    this.byteCount += encoder.encode(textDelta).byteLength;
    const probe = this.buffered.replace(/^\s+/, "");
    for (const marker of ECHO_MARKERS) {
      if (probe.startsWith(marker)) {
        this.done = true;
        return { kind: "echo", marker };
      }
    }
    const stillPrefix = ECHO_MARKERS.some(marker =>
      probe.length < marker.length && marker.startsWith(probe),
    );
    if (stillPrefix && this.byteCount <= MAX_SNIFF_BYTES && this.buffered.length < MAX_HOLD_BYTES) {
      return { kind: "hold" };
    }
    // Diverged, exceeded the sniff window, or exceeded the hold cap: not an echo.
    this.done = true;
    return { kind: "flush" };
  }

  /** End-of-stream: anything still held is not an echo. */
  finish(): EchoSnifferDecision {
    if (this.done) return { kind: "flush" };
    this.done = true;
    return { kind: "flush" };
  }
}

/**
 * Corrective active-turn text for the single echo retry. Deliberately does NOT
 * contain the marker strings themselves (repeating the trigger inside the
 * prompt is what made the static guard note ineffective).
 */
export const CURSOR_ECHO_RETRY_CONTINUATION_TEXT =
  "Your previous reply copied an internal tool-output record verbatim and was rejected. Continue the original task now: issue the next required tool call, or answer in your own words if no tool is needed.";
