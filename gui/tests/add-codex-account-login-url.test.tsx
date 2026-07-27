import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddCodexAccountModal from "../src/components/AddCodexAccountModal";

/**
 * The Codex account add/reauth modal was the last login surface without a way
 * to obtain the authorization URL: it rendered a copy button and nothing else,
 * so a blocked clipboard left the user with no path forward, and a copy failure
 * surfaced in the login error channel.
 */

const AUTH_URL = "https://auth.openai.test/oauth/authorize?client_id=codex&state=zzz";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let clipboardWrites: string[] = [];
let statusHolders: Array<{ resolve: (value: Response) => void }> = [];

function installClipboard(available: boolean) {
  clipboardWrites = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: available
      ? { writeText: async (text: string) => { clipboardWrites.push(text); } }
      : undefined,
  });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installClipboard(true);

  originalFetch = globalThis.fetch;
  statusHolders = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/codex-auth/login") {
        return Response.json({ url: AUTH_URL, flowId: "flow-1" });
      }
      if (url.pathname === "/api/codex-auth/login-status") {
        return await new Promise<Response>((resolve) => { statusHolders.push({ resolve }); });
      }
      return Response.json({});
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  for (const holder of statusHolders.splice(0)) {
    holder.resolve(Response.json({ status: "pending" }));
  }
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

/** Reauth enters the waiting step immediately, but authUrl arrives a tick later. */
async function mountReauthModal() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddCodexAccountModal apiBase="" onClose={() => {}} onAdded={() => {}} reauthAccountId="acct-1" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

function copyButton(): HTMLButtonElement {
  const button = host.querySelector(".login-url-block-actions button");
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

test("the waiting step exposes the authorization URL and a manual open link", async () => {
  await mountReauthModal();

  expect(host.textContent).toContain(AUTH_URL);

  const anchor = Array.from(host.querySelectorAll("a")).find(
    (el) => el.getAttribute("href") === AUTH_URL,
  );
  expect(anchor).toBeTruthy();
  expect(anchor?.getAttribute("target")).toBe("_blank");
  expect(host.textContent).toContain("Didn't open?");
});

test("copying the login URL reports success on the button, not in a notice", async () => {
  await mountReauthModal();

  await act(async () => {
    copyButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(clipboardWrites).toEqual([AUTH_URL]);
  expect(host.textContent).toContain("Copied");
});

test("a blocked clipboard never reaches the login error channel", async () => {
  installClipboard(false);
  await mountReauthModal();

  await act(async () => {
    copyButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(host.textContent).toContain("Clipboard unavailable");
  // A copy failure used to dispatch set-error, mixing it with login failures.
  expect(host.querySelector(".notice-err")).toBeNull();
  // The URL stays selectable, so the user still has a recovery path.
  expect(host.textContent).toContain(AUTH_URL);
});
