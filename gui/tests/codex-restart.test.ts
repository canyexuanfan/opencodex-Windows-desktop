import { describe, expect, test } from "bun:test";
import { requestCodexRestart } from "../src/codex-restart";
import type { CodexRestartResponse } from "../src/codex-restart";

const STOPPED: CodexRestartResponse = {
  success: true,
  stateBefore: "stale",
  synced: true,
  requested: [4242],
  stopped: [4242],
  surviving: [],
  failed: [],
  code: "stopped",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const formatters = {
  formatFailure: (status: number) => `http ${status}`,
  formatUnreachable: () => "unreachable",
  formatMalformed: () => "malformed",
};

describe("requestCodexRestart", () => {
  test("returns the parsed contract body on success", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response(STOPPED)) as typeof fetch,
      ...formatters,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual(STOPPED);
  });

  test("surfaces a non-2xx status through formatFailure", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ error: "nope" }, 500)) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "http 500" });
  });

  test("treats a dropped connection as failure, unlike the stop route", async () => {
    // requestProxyStop reads a dropped socket as "the stop started". This route
    // does not kill the process serving it, so silence means something broke.
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => {
        throw new DOMException("The operation timed out.", "AbortError");
      }) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "unreachable" });
  });

  test("rejects an unparseable 2xx body", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("rejects a parseable 2xx body of the wrong shape", async () => {
    // The handler reads .stopped.length; a bare { success: true } would throw
    // inside an event handler, where it surfaces as a dead button.
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ success: true })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("rejects a body whose pid arrays are not pids", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, stopped: ["4242"] })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("rejects a negative or fractional pid", async () => {
    const negative = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, stopped: [-1] })) as typeof fetch,
      ...formatters,
    });
    const fractional = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, surviving: [1.5] })) as typeof fetch,
      ...formatters,
    });

    expect(negative.ok).toBe(false);
    expect(fractional.ok).toBe(false);
  });

  test("rejects an unknown response code", async () => {
    const outcome = await requestCodexRestart("", {
      fetchFn: (async () => response({ ...STOPPED, code: "exploded" })) as typeof fetch,
      ...formatters,
    });

    expect(outcome).toEqual({ ok: false, message: "malformed" });
  });

  test("posts to the codex-restart path", async () => {
    let seen = "";
    let method = "";
    await requestCodexRestart("http://127.0.0.1:10100", {
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        seen = String(input);
        method = String(init?.method);
        return response(STOPPED);
      }) as unknown as typeof fetch,
      ...formatters,
    });

    expect(seen).toBe("http://127.0.0.1:10100/api/system/codex-restart");
    expect(method).toBe("POST");
  });

  test("passes each response code through for the caller to map", async () => {
    const codes = ["stopped", "nothing_running", "enumeration_unavailable", "partially_stopped"] as const;
    for (const code of codes) {
      const outcome = await requestCodexRestart("", {
        fetchFn: (async () => response({ ...STOPPED, code })) as typeof fetch,
        ...formatters,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.code).toBe(code);
    }
  });
});

