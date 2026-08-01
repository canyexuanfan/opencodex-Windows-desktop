import { describe, expect, test } from "bun:test";
import {
  drainAndShutdown,
  registerTurn,
  unregisterTurn,
  isDraining,
  getActiveTurnCount,
  trackStreamLifetime,
  isRecyclingForExit,
  markRecyclingForExit,
} from "../src/server";
import { activeRegistryMetrics, tryAdmitTurn } from "../src/server/lifecycle";

describe("active turn tracking", () => {
  test("admit/bind/unregister tracks active turns through the boundary lease", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const before = getActiveTurnCount();
    const lease1 = tryAdmitTurn();
    const lease2 = tryAdmitTurn();
    expect(lease1).not.toBeNull();
    expect(lease2).not.toBeNull();
    registerTurn(ac1, lease1!);
    registerTurn(ac2, lease2!);
    expect(getActiveTurnCount()).toBe(before + 2);
    unregisterTurn(ac1);
    expect(getActiveTurnCount()).toBe(before + 1);
    unregisterTurn(ac2);
    expect(getActiveTurnCount()).toBe(before);
  });

  test("isDraining() is false by default", () => {
    expect(isDraining()).toBe(false);
  });

  test("forced shutdown releases an admitted turn before controller binding", async () => {
    const before = getActiveTurnCount();
    const releaseMissesBefore = activeRegistryMetrics().activeTurns.releaseMisses;
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    expect(getActiveTurnCount()).toBe(before + 1);

    await drainAndShutdown(undefined, 0);

    expect(getActiveTurnCount()).toBe(before);
    const lateController = new AbortController();
    registerTurn(lateController, lease!);
    expect(lateController.signal.aborted).toBe(true);
    unregisterTurn(lateController);
    lease?.release();
    expect(getActiveTurnCount()).toBe(before);
    expect(activeRegistryMetrics().activeTurns.releaseMisses).toBe(releaseMissesBefore);
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
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const tracked = trackStreamLifetime(source, ac, undefined, lease!);
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
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const tracked = trackStreamLifetime(source, ac, undefined, lease!);
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
