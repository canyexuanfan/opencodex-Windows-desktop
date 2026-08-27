/**
 * External Cursor output quarantine (devlog 260826 gaps 10-11).
 *
 * Gap 10: flattened tool-result history can prime an external model to echo the
 * "[Tool Result]" envelope as its own reply.
 *
 * Gap 11: a model can invent a blocked native-tool attempt in visible commentary
 * even though the only real current-turn tool is the advertised Codex bridge.
 *
 * Both failures are observable only at the output boundary. The sniffers below
 * hold a bounded prefix until it either diverges or proves the failure, allowing
 * cursor.ts to retry before any invalid text reaches the client.
 */

const ECHO_MARKERS = ["[Tool Result]", "[Tool Error]", "[tool_result]"] as const;
const MAX_SNIFF_BYTES = 40;
const MAX_ROUTING_COMMENTARY_BYTES = 512;
/** Aggregate quarantine cap: past this, flush and disarm. */
const MAX_HOLD_BYTES = 8 * 1024;
const encoder = new TextEncoder();

export class CursorToolResultEchoError extends Error {
  readonly code = "cursor_tool_result_echo";
  constructor(marker: string) {
    super(
      "Cursor external model echoed the replayed tool-result envelope (\"" + marker
      + "\") instead of continuing the task.",
    );
    this.name = "CursorToolResultEchoError";
  }
}

export class CursorRoutingCommentaryError extends Error {
  readonly code = "cursor_routing_commentary_hallucination";
  constructor() {
    super("Cursor external model invented a blocked tool surface before any tool call occurred.");
    this.name = "CursorRoutingCommentaryError";
  }
}

export type EchoSnifferDecision =
  | { kind: "hold" }
  | { kind: "flush" }
  | { kind: "echo"; marker: string };

/**
 * Incremental envelope-prefix sniffer. Leading whitespace is tolerated so a
 * marker copied after a newline is still caught.
 */
export class CursorEnvelopeEchoSniffer {
  private buffered = "";
  private byteCount = 0;
  private done = false;

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
    this.done = true;
    return { kind: "flush" };
  }

  finish(): EchoSnifferDecision {
    if (this.done) return { kind: "flush" };
    this.done = true;
    return { kind: "flush" };
  }
}

export type RoutingCommentaryDecision =
  | { kind: "hold" }
  | { kind: "flush" }
  | { kind: "hallucination" };

const ROUTING_NATIVE_TOOL_NAME = /\b(shell|read|grep|list|bash)\b/giu;
const ROUTING_TOOL_HINT =
  /(?:\b(?:shell|read|grep|list|bash)\b|exec_command|shell_command|브리지|네이티브\s*(?:셸|쉘))/iu;
const ROUTING_FAILURE_CLAIM =
  /(?:blocked|unavailable|interrupted|차단|중단|막혀)/iu;
const ROUTING_REDIRECT_CLAIM =
  /(?:exec_command|shell_command|\bexec\b|브리지|redirected|fallback|switch(?:ed|ing)?|전환|우회|통과(?:되|하)|다른\s*(?:도구|경로)|경로로)/iu;

/**
 * Quarantines the first line of code-mode / bridge output long enough to reject
 * an impossible routing claim. It requires a failure claim plus either an
 * explicit redirect to another execution surface or two distinct unadvertised
 * native-tool names; a legitimate sentence such as "Shell is unavailable on
 * this OS" therefore passes.
 */
export class CursorRoutingCommentarySniffer {
  private buffered = "";
  private byteCount = 0;
  private done = false;

  get settled(): boolean {
    return this.done;
  }

  feed(textDelta: string): RoutingCommentaryDecision {
    if (this.done) return { kind: "flush" };
    this.buffered += textDelta;
    this.byteCount += encoder.encode(textDelta).byteLength;
    if (this.matchesHallucination()) {
      this.done = true;
      return { kind: "hallucination" };
    }
    const lineBreakCount = (this.buffered.match(/\n/gu) ?? []).length;
    const hasRoutingHint = ROUTING_TOOL_HINT.test(this.buffered) || ROUTING_FAILURE_CLAIM.test(this.buffered);
    const pendingFailureClaim =
      ROUTING_TOOL_HINT.test(this.buffered)
      && ROUTING_FAILURE_CLAIM.test(this.buffered)
      && lineBreakCount < 2;
    if (
      this.byteCount < MAX_ROUTING_COMMENTARY_BYTES
      && this.buffered.length < MAX_HOLD_BYTES
      && (lineBreakCount === 0 || pendingFailureClaim)
      && (hasRoutingHint || this.byteCount < 64)
    ) {
      return { kind: "hold" };
    }
    this.done = true;
    return { kind: "flush" };
  }

  finish(): RoutingCommentaryDecision {
    if (this.done) return { kind: "flush" };
    this.done = true;
    return this.matchesHallucination() ? { kind: "hallucination" } : { kind: "flush" };
  }

  private matchesHallucination(): boolean {
    if (!ROUTING_FAILURE_CLAIM.test(this.buffered)) return false;
    const nativeTools = new Set(
      [...this.buffered.matchAll(ROUTING_NATIVE_TOOL_NAME)].map(match => match[1]?.toLowerCase()),
    );
    if (nativeTools.size === 0) return false;
    return ROUTING_REDIRECT_CLAIM.test(this.buffered) || nativeTools.size >= 2;
  }
}

export const CURSOR_ECHO_RETRY_CONTINUATION_TEXT =
  "Your previous reply copied an internal tool-output record verbatim and was rejected. Continue the original task now: issue the next required tool call, or answer in your own words if no tool is needed.";

export const CURSOR_ROUTING_COMMENTARY_RETRY_TEXT =
  "Your previous reply claimed an execution-surface failure that did not occur and was rejected. Use the current tool catalog as ground truth. Perform the requested operation through the advertised execution tool now, with no commentary before the tool call.";
