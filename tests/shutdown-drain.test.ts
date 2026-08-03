import { describe, expect, test } from "bun:test";
import {
  registerTurn,
  unregisterTurn,
  isDraining,
  getActiveTurnCount,
  MAX_ACTIVE_TURNS,
  trackStreamLifetime,
  tryAdmitTurn,
  isRecyclingForExit,
  markRecyclingForExit,
} from "../src/server";

describe("active turn tracking", () => {
  test("register/unregister tracks active turns", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const before = getActiveTurnCount();
    registerTurn(ac1);
    registerTurn(ac2);
    expect(getActiveTurnCount()).toBe(before + 2);
    unregisterTurn(ac1);
    expect(getActiveTurnCount()).toBe(before + 1);
    unregisterTurn(ac2);
    expect(getActiveTurnCount()).toBe(before);
  });

  test("isDraining() is false by default", () => {
    expect(isDraining()).toBe(false);
  });

  test("admission lease bounds pending turns and releases the bound controller", () => {
    const baseline = getActiveTurnCount();
    const leases: Array<NonNullable<ReturnType<typeof tryAdmitTurn>>> = [];
    try {
      for (let i = baseline; i < MAX_ACTIVE_TURNS; i += 1) {
        const lease = tryAdmitTurn();
        expect(lease).not.toBeNull();
        lease!.bindAbortController(new AbortController());
        leases.push(lease!);
      }
      expect(tryAdmitTurn()).toBeNull();
      expect(getActiveTurnCount()).toBe(MAX_ACTIVE_TURNS);
    } finally {
      for (const lease of leases) lease.release();
    }
    expect(getActiveTurnCount()).toBe(baseline);
    const probe = tryAdmitTurn();
    expect(probe).not.toBeNull();
    probe?.release();
  });
});

describe("trackStreamLifetime", () => {
  test("registers on start and unregisters on stream close", async () => {
    const enc = new TextEncoder();
    const chunks = [enc.encode("hello"), enc.encode("world")];
    let i = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      },
    });
    const ac = new AbortController();
    const before = getActiveTurnCount();
    const tracked = trackStreamLifetime(source, ac);
    expect(getActiveTurnCount()).toBe(before + 1);

    const reader = tracked.getReader();
    const dec = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toBe("helloworld");
    expect(getActiveTurnCount()).toBe(before);
  });

  test("unregisters on cancel", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull() {
        // never closes — simulate long stream
      },
    });
    const ac = new AbortController();
    const before = getActiveTurnCount();
    const tracked = trackStreamLifetime(source, ac);
    expect(getActiveTurnCount()).toBe(before + 1);

    await tracked.cancel("test cancel");
    expect(getActiveTurnCount()).toBe(before);
    expect(ac.signal.aborted).toBe(true);
  });
});

describe("recycling exit flag (#563)", () => {
  test("markRecyclingForExit flips the recycle sentinel for syncCleanup", () => {
    expect(isRecyclingForExit()).toBe(false);
    markRecyclingForExit();
    expect(isRecyclingForExit()).toBe(true);
  });
});
