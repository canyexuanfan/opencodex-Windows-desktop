import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

/**
 * Mounted behavior for the Integrations surfaces.
 *
 * The adapter suite proves the wire contract and stops there, which let three
 * real defects ship green: a switch labelled Disable that sent an apply, a
 * restore control disabled for every row the server would actually have
 * accepted, and refusals that reached the user without the recovery
 * information the server took care to send. Each test here drives the real
 * component against a real fetch mock and asserts what the user sees or what
 * goes out on the wire.
 */

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: unknown }> = [];
/**
 * `useDataSurface` caches by key, and the key includes `apiBase`. Reusing one
 * base across tests replayed the previous test's response, so a fixture change
 * silently had no effect — several of these tests passed against stale data
 * before this counter existed.
 */
let mountCount = 0;
let apiBase = "";

type JournalRow = {
  opId: string;
  clientId: string;
  kind: string;
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
};

let stateResponse: () => Response;
let journalRows: JournalRow[];
let putResponse: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "hermes",
    state: "current",
    installed: true,
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshotCount: 1,
    retentionDegraded: false,
    ...overrides,
  };
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/hermes" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  journalRows = [];
  mountCount += 1;
  apiBase = `http://ocx-test-${mountCount}.invalid`;
  stateResponse = () => json(status());
  putResponse = () => json({ ok: true, clientId: "hermes", changed: true, state: "absent", message: "disabled" });

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/journal")) return json({ operations: journalRows });
    if (method === "PUT") return putResponse();
    if (url.includes("/restore")) return json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "restored" });
    return stateResponse();
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountClient(active = true): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: FileIntegrationPage }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/FileIntegrationPage"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <FileIntegrationPage apiBase={apiBase} client="hermes" active={active} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[];
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find(button => (button.textContent ?? "").trim() === text);
}

function toggleSwitch(): HTMLButtonElement {
  const found = buttons().find(button => button.className.includes("switch"));
  if (!found) throw new Error("integration switch not found");
  return found;
}

test("turning the switch off disables, even when the block is stale", async () => {
  /*
   * The defect this pins: `stale` also means our block is on disk, so the
   * switch reads applied — and it used to send `enabled: true` for that state,
   * asking the server to REFRESH while the control was labelled Disable. The
   * user's config stayed connected after they turned it off.
   */
  stateResponse = () => json(status({ state: "stale" }));
  await mountClient();

  const sw = toggleSwitch();
  expect(sw.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { sw.click(); });

  const put = requests.find(request => request.method === "PUT");
  expect(put?.body).toEqual({ enabled: false });
});

test("updating a stale block is a separate action from the switch", async () => {
  stateResponse = () => json(status({ state: "stale" }));
  await mountClient();

  const update = buttonByText("Update");
  expect(update).toBeDefined();
  await act(async () => { update!.click(); });
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: true });
});

test("an absent integration applies", async () => {
  stateResponse = () => json(status({ state: "absent" }));
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  expect(requests.find(request => request.method === "PUT")?.body).toEqual({ enabled: true });
});

test("conflict locks the switch instead of guessing", async () => {
  // Never auto-resolved: the alternative is deleting an edit we do not own.
  stateResponse = () => json(status({ state: "conflict", reason: "foreign-edit" }));
  await mountClient();
  expect(toggleSwitch().disabled).toBe(true);
});

test("unsafe locks the switch instead of guessing", async () => {
  stateResponse = () => json(status({ state: "unsafe", reason: "unparseable" }));
  await mountClient();
  expect(toggleSwitch().disabled).toBe(true);
});

test("a restore point the server would accept is offered, not disabled", async () => {
  /*
   * `undoable: false` on a non-expired row is the ordinary case — an older
   * operation, or a file edited since. The server answers those with
   * `drift_requires_confirm` and accepts an explicit confirmation, so
   * disabling the control made that confirmation unreachable.
   */
  journalRows = [{
    opId: "op-old",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T09:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored",
    undoable: false,
  }];
  await mountClient();

  const restore = buttonByText("Restore this point…");
  expect(restore).toBeDefined();
  expect(restore!.disabled).toBe(false);
});

test("the newest undoable row is offered as Undo", async () => {
  journalRows = [{
    opId: "op-new",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T10:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "stored",
    undoable: true,
  }];
  await mountClient();
  expect(buttonByText("Undo")).toBeDefined();
});

test("an expired snapshot offers nothing, because the bytes are gone", async () => {
  journalRows = [{
    opId: "op-gone",
    clientId: "hermes",
    kind: "apply",
    at: "2026-08-02T08:00:00.000Z",
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshot: "expired",
    undoable: false,
  }];
  await mountClient();
  expect(buttonByText("Restore this point…")).toBeUndefined();
  expect(buttonByText("Undo")).toBeUndefined();
  expect(container.innerHTML).toContain("Backup expired");
});

test("a residual write tells the user the file may be half-written and where the backup is", async () => {
  /*
   * `residual` means compensation itself failed. It is the single most
   * important field in a refusal and nothing rendered it: the user was told
   * the change failed and left believing their file was untouched.
   */
  putResponse = () => json({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId: "hermes",
    state: "current",
    reason: "write_failed",
    message: "the journal could not be written",
    snapshotPath: "/tmp/store/snapshots/hermes/op-1",
    residual: true,
  }, 500);
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  const text = container.textContent ?? "";
  expect(text).toContain("intermediate state");
  expect(text).toContain("/tmp/store/snapshots/hermes/op-1");
  expect(text).toContain("the journal could not be written");
});

test("a refusal routes by reason, not by the state it happened in", async () => {
  // `write_failed` while the file reads `conflict`: mapping on state would
  // tell the user to resolve a conflict that is not what went wrong.
  putResponse = () => json({
    error: "integration mutation failed",
    code: "integration_mutation_failed",
    clientId: "hermes",
    state: "conflict",
    reason: "write_failed",
    message: "disk full",
  }, 500);
  await mountClient();
  await act(async () => { toggleSwitch().click(); });
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 20)); });

  const text = container.textContent ?? "";
  expect(text).toContain("disk full");
  expect(text).not.toContain("changed after opencodex wrote it");
});

test("a hidden panel makes no request at all", async () => {
  await mountClient(false);
  // Panels stay mounted while hidden to preserve drafts; `active` is the only
  // thing keeping them from polling behind the tab the user is looking at.
  expect(requests).toEqual([]);
});
