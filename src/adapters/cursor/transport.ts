import type { OcxProviderConfig } from "../../types";
import type { CursorClientMessage, CursorRunRequest, CursorServerMessage } from "./types";

export interface CursorTransport {
  run(request: CursorRunRequest, signal?: AbortSignal): AsyncIterable<CursorServerMessage>;
  writeClient(message: CursorClientMessage): void | Promise<void>;
  close?(): void | Promise<void>;
  /**
   * Whether the run request has been committed to the wire. The retry orchestrator only re-dials
   * failures that happened BEFORE this becomes true, so a turn the Cursor server may already have
   * accepted is never replayed. Absent (undefined) is treated as "committed" — safe by default.
   */
  requestCommitted?(): boolean;
}

export interface CursorTransportFactoryInput {
  provider: OcxProviderConfig;
  headers?: Headers;
  /** Pre-first-frame deadline (dial + first server frame). Defaults to 30s when omitted. */
  firstFrameTimeoutMs?: number;
}

export type CursorTransportFactory = (input: CursorTransportFactoryInput) => CursorTransport;

export class CursorTransportDisabledError extends Error {
  readonly code = "cursor_transport_disabled";

  constructor(message = "live Cursor transport is disabled") {
    super(message);
    this.name = "CursorTransportDisabledError";
  }
}

export function createDisabledCursorTransport(): CursorTransport {
  return {
    async *run() {
      throw new CursorTransportDisabledError();
    },
    writeClient() {},
    close() {},
  };
}
