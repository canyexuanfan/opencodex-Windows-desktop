import http2 from "node:http2";

const DEFAULT_MAX_SESSIONS = 8;
const SESSION_CLOSE_TIMEOUT_MS = 2_000;

interface PoolEntry {
  readonly session: http2.ClientHttp2Session;
  readonly streams: Set<http2.ClientHttp2Stream>;
  usable: boolean;
}

/**
 * HTTP/2 connection pool for Cursor Connect unary/stream calls.
 * Sessions are keyed by origin (scheme+host+port) and reused across
 * GetUsableModels / Run requests to avoid fresh TCP+TLS per call.
 */
export class CursorH2SessionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private closed = false;

  constructor(private readonly maxSessions = DEFAULT_MAX_SESSIONS) {}

  request(
    url: string,
    headers: http2.OutgoingHttpHeaders,
  ): http2.ClientHttp2Stream {
    if (this.closed) throw new Error("Cursor H2 session pool is closed");
    const origin = new URL(url).origin;
    const entry = this.usableEntry(origin) ?? this.createEntry(origin);
    try {
      const stream = entry.session.request(headers);
      entry.streams.add(stream);
      stream.once("close", () => { entry.streams.delete(stream); });
      return stream;
    } catch (error) {
      this.drain(entry, true);
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending: Promise<void>[] = [];
    for (const entry of [...this.entries.values()]) {
      for (const stream of [...entry.streams]) stream.destroy();
      entry.session.close();
      if (entry.session.destroyed) continue;
      pending.push(new Promise<void>(resolve => {
        const timer = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS);
        timer.unref?.();
        entry.session.once("close", () => { clearTimeout(timer); resolve(); });
      }));
    }
    this.entries.clear();
    await Promise.all(pending);
  }

  get size(): number { return this.entries.size; }

  private usableEntry(origin: string): PoolEntry | undefined {
    const entry = this.entries.get(origin);
    if (!entry) return undefined;
    if (entry.usable && !entry.session.closed && !entry.session.destroyed) return entry;
    this.drain(entry, false);
    return undefined;
  }

  private createEntry(origin: string): PoolEntry {
    const session = http2.connect(origin);
    const entry: PoolEntry = {
      session,
      streams: new Set(),
      usable: true,
    };
    this.entries.set(origin, entry);
    session.once("goaway", () => { this.drain(entry, true); });
    session.on("error", () => { this.drain(entry, false); });
    session.once("close", () => {
      // Identity check: a stale close event from an old session must not evict
      // a healthy replacement entry that was created after drain() removed the old one.
      if (this.entries.get(origin) === entry) this.entries.delete(origin);
    });
    // Enforce bound: evict oldest when over capacity.
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (!oldest || oldest === origin) break;
      const old = this.entries.get(oldest);
      if (old) this.drain(old, true);
    }
    return entry;
  }

  private drain(entry: PoolEntry, closeSession: boolean): void {
    entry.usable = false;
    for (const stream of [...entry.streams]) stream.destroy();
    entry.streams.clear();
    if (closeSession) entry.session.close();
    // Remove from map by finding the matching key.
    for (const [key, value] of this.entries) {
      if (value === entry) { this.entries.delete(key); break; }
    }
  }
}

/** Shared singleton pool for all Cursor adapter H2 traffic. */
export const cursorH2Pool = new CursorH2SessionPool();
