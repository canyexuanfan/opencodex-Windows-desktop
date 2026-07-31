/**
 * Darwin eager-relay abort-stress probe — CHILD (server) process.
 *
 * Serves the ACTUAL relaySseEagerBounded stream (src/server/relay-eager.ts)
 * as a Bun.serve HTTP Response body — the JS-stream→native-sink boundary that
 * Bun#32111 concerns. The parent (scripts/darwin-eager-abort-stress.ts) is
 * the external watchdog; this process only reports readiness and serves.
 *
 * Spec: devlog/_plan/260731_macos_rss_retention/100_darwin_eager_optin.md
 * §Abort-stress gate. This is a probe, not a test or CI job. JSON phase
 * markers let the parent prove that every abort happened inside its intended
 * boundary rather than merely counting attempted client requests.
 */
import { relaySseEagerBounded } from "../src/server/relay-eager";
import { createSseInspector } from "../src/server/relay";

type AbortClass = "before-first-byte" | "mid-frame" | "during-backpressure";

const encoder = new TextEncoder();

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function sseEvent(index: number, bytes: number): Uint8Array {
  const payload = JSON.stringify({
    type: "response.output_text.delta",
    delta: "x".repeat(Math.max(0, bytes - 80)),
    index,
  });
  return encoder.encode(`data: ${payload}\n\n`);
}

function isAbortClass(value: string | null): value is AbortClass {
  return value === "before-first-byte" || value === "mid-frame" || value === "during-backpressure";
}

function makeUpstream(
  id: string,
  abortClass: AbortClass,
  lifecycle: { done: boolean; pulls: number },
): ReadableStream<Uint8Array> {
  let sent = 0;
  let phaseEmitted = false;
  const emitPhase = () => {
    if (phaseEmitted) return;
    phaseEmitted = true;
    emit({ type: "phase", id, class: abortClass });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      lifecycle.pulls += 1;
      if (abortClass === "before-first-byte") {
        if (sent === 0) {
          // Marker precedes the first body byte; the parent aborts only after
          // observing this window.
          emitPhase();
          await Bun.sleep(25);
        }
        controller.enqueue(sseEvent(sent++, 2 * 1024));
      } else if (abortClass === "mid-frame") {
        if (sent === 0) {
          // Deliberately split one SSE JSON frame. The marker is emitted after
          // the opening bytes but before the frame terminator/JSON close.
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"'));
          sent += 1;
          emitPhase();
          return;
        }
        if (sent === 1) {
          await Bun.sleep(25);
          controller.enqueue(encoder.encode('continued"}\n\n'));
          sent += 1;
          return;
        }
        controller.enqueue(sseEvent(sent++, 2 * 1024));
      } else {
        // A large, fast source drives sustained transfer through the real
        // eager relay. MEASURED on darwin Bun 1.3.14: the native Response
        // sink pulls a JS ReadableStream WITHOUT pacing (an unread client
        // still drains the whole upstream), so a parked producer is not
        // reachable over HTTP on this runtime. The class therefore proves
        // "abort during native-sink buffering with the queue bound exceeded"
        // — the load state relevant to Bun#32111 — via the delivered-bytes
        // marker below, not a parked-pull-count.
        controller.enqueue(sseEvent(sent++, 8 * 1024));
        if (!phaseEmitted && sent * 8 * 1024 >= 1024 * 1024) emitPhase();
      }

      const limit = abortClass === "during-backpressure" ? 65_536 : 256;
      if (sent >= limit) {
        controller.enqueue(encoder.encode(`data: {"type":"response.completed","response":{"id":"probe","status":"completed","output":[]}}\n\ndata: [DONE]\n\n`));
        lifecycle.done = true;
        controller.close();
      }
    },
    cancel() {
      lifecycle.done = true;
    },
  });
}

let shuttingDown = false;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/shutdown" && req.method === "POST") {
      if (!shuttingDown) {
        shuttingDown = true;
        emit({ type: "shutdown-ack" });
        setTimeout(() => {
          server.stop(true);
          process.exit(0);
        }, 25);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/sse") return new Response("not found", { status: 404 });

    const id = url.searchParams.get("id");
    const abortClass = url.searchParams.get("class");
    if (!id || !/^[a-z0-9-]{1,96}$/.test(id) || !isAbortClass(abortClass)) {
      return Response.json({ error: "invalid id or abort class" }, { status: 400 });
    }

    const upstream = new AbortController();
    const inspector = createSseInspector({});
    const lifecycle = { done: false, pulls: 0 };
    const upstreamBody = makeUpstream(id, abortClass, lifecycle);

    // during-backpressure phase proof lives in makeUpstream: the marker fires
    // only after >=1 MiB has passed through the relay into the native sink
    // with the client not reading (see the measured-behavior comment there).
    const monitor: ReturnType<typeof setInterval> | undefined = undefined;

    const body = relaySseEagerBounded(upstreamBody, upstream, {
      inspectChunk: chunk => inspector.feed(chunk),
      finishInspection: () => inspector.finish(),
      sawTerminal: () => inspector.reported(),
      onSynthetic: () => {},
      onClientCancel: () => {},
      onDone: () => {
        lifecycle.done = true;
        if (monitor) clearInterval(monitor);
      },
      disposeInspection: () => inspector.dispose(),
    }, {
      // One 64 KiB source chunk exceeds this queue bound, making the producer's
      // pause gate observable as soon as the native sink stops pulling.
      maxQueueBytes: 32 * 1024,
      postCancelDrainMs: 250,
      postCancelDrainBytes: 256 * 1024,
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

// Readiness marker the parent watches for.
emit({ type: "ready", port: server.port });
