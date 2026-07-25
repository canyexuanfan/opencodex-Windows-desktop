import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCodexAccountPool, type CodexAccountPoolController } from "../src/hooks/useCodexAccountPool";

/**
 * WP3 behavioural contract. The sibling .ts file pins source-level invariants; this one
 * exercises the controller at runtime, because a shared-state claim proven only by
 * substring checks is not proven at all.
 */

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let calls: string[] = [];
let accounts: unknown[] = [];
let threshold = 80;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  calls = [];
  accounts = [{ id: "a1", email: "a@x.com", isMain: true, hasCredential: true, quota: null }];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = String(url).split("/api/")[1] ?? String(url);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("codex-auth/accounts")) {
        return { ok: true, json: async () => ({ accounts }) } as unknown as Response;
      }
      if (path.startsWith("codex-auth/active")) {
        return { ok: true, json: async () => ({ activeCodexAccountId: null, autoSwitchThreshold: threshold }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
});

/** Mounts the hook and exposes the live controller. */
async function mountController(enabled = true) {
  const seen: { current: CodexAccountPoolController | null } = { current: null };
  function Probe() {
    seen.current = useCodexAccountPool("", enabled);
    return null;
  }
  await act(async () => {
    root = createRoot(host);
    root.render(<Probe />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return seen;
}

test("the controller loads once on mount", async () => {
  const seen = await mountController();
  expect(seen.current).not.toBeNull();
  expect(calls.filter(c => c.includes("codex-auth/accounts")).length).toBe(1);
  expect(seen.current!.accounts.length).toBe(1);
  expect(seen.current!.loadState).toBe("ready");
});

test("an inert controller issues no requests at all", async () => {
  await mountController(false);
  expect(calls.length).toBe(0);
});

test("two pause holders both have to release before polling resumes", async () => {
  const seen = await mountController();
  const controller = seen.current!;

  let first: ReturnType<CodexAccountPoolController["pauseRefresh"]>;
  let second: ReturnType<CodexAccountPoolController["pauseRefresh"]>;
  await act(async () => { first = controller.pauseRefresh(); });
  await act(async () => { second = controller.pauseRefresh(); });

  const afterPause = calls.length;
  // Releasing one lease must not resume: a reason-string Set would fail here.
  await act(async () => { seen.current!.resumeRefresh(first!); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(calls.length).toBe(afterPause);

  // Releasing the last lease must not retro-fire a load either.
  await act(async () => { seen.current!.resumeRefresh(second!); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(calls.length).toBe(afterPause);

  // An unknown token is harmless.
  await act(async () => { seen.current!.resumeRefresh({} as typeof first); });
  expect(calls.length).toBe(afterPause);
});

test("subscribing never fabricates a server read", async () => {
  const seen = await mountController();
  const received: unknown[] = [];

  await act(async () => {
    seen.current!.subscribeLoadObserver({
      beginActiveRead: () => 1,
      acceptActiveRead: (value) => { received.push(value); },
      rejectActiveRead: () => {},
    });
  });

  // A replay-on-subscribe was tried and rejected: useCodexAutoSwitch treats every
  // acceptActiveRead as belonging to a read that genuinely started at that revision, so
  // a synthesised accept corrupted its editing/saving disposition and overwrote drafts
  // the user was typing. Subscribing is therefore silent; the next load notifies.
  expect(received).toEqual([]);

  // And a real load does reach the subscriber.
  await act(async () => { await seen.current!.load(); });
  expect(received).toEqual([80]);
});

test("a mutation updates the one shared controller state", async () => {
  const seen = await mountController();
  accounts = [
    { id: "a1", email: "a@x.com", isMain: true, hasCredential: true, quota: null },
    { id: "a2", email: "b@x.com", isMain: false, hasCredential: true, quota: null },
  ];

  await act(async () => { await seen.current!.switchAccount("a2"); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  expect(calls).toContain("PUT codex-auth/active");
  expect(seen.current!.activeId).toBe("a2");
  // The reconciliation reload landed on the same controller instance.
  expect(seen.current!.accounts.map(a => a.id)).toEqual(["a1", "a2"]);
});
