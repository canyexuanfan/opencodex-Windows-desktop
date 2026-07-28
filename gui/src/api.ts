let installed = false;
let promptInFlight: Promise<string | null> | null = null;

function needsApiAuth(input: RequestInfo | URL): boolean {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    // Absolute cross-origin URLs must never get the local API token or 401 prompt.
    if (url.origin !== window.location.origin) return false;
    return url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Legacy sessionStorage key from pre-memory auth — wiped once on install, never read. */
const LEGACY_TOKEN_KEY = "opencodex-api-token";

/** In-memory only — never write tokens to web storage (XSS can read sessionStorage/localStorage). */
let memoryToken: string | null = null;
let memoryCsrfToken: string | null = null;
let memorySessionOrigin: string | null = null;

function readToken(): string | null {
  return memoryToken;
}

function storeToken(token: string): void {
  memoryToken = token;
}

function clearToken(): void {
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
}

function takeMetaContent(name: string): string | null {
  const element = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  const content = element?.content.trim() || null;
  element?.remove();
  return content;
}

function loadInjectedSession(): void {
  const token = takeMetaContent("opencodex-session-token");
  const csrfToken = takeMetaContent("opencodex-session-csrf");
  const origin = takeMetaContent("opencodex-session-origin");
  if (!token?.startsWith("ocx_session_") || !csrfToken || origin !== window.location.origin) return;
  memoryToken = token;
  memoryCsrfToken = csrfToken;
  memorySessionOrigin = origin;
}

function clearLegacySessionToken(): void {
  try {
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* session storage may be disabled */
  }
}

function withToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-OpenCodex-API-Key", token);
  if (memorySessionOrigin && memoryCsrfToken && token.startsWith("ocx_session_")) {
    headers.set("X-OpenCodex-GUI-Origin", memorySessionOrigin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      headers.set("X-OpenCodex-CSRF-Token", memoryCsrfToken);
    }
  }
  if (input instanceof Request) return [new Request(input, { headers }), init ? { ...init, headers } : undefined];
  return [input, { ...init, headers }];
}

async function promptForToken(): Promise<string | null> {
  if (promptInFlight) return promptInFlight;
  promptInFlight = Promise.resolve()
    .then(() => window.prompt("OpenCodex API token")?.trim() || null)
    .finally(() => { promptInFlight = null; });
  return promptInFlight;
}

export function installApiAuthFetch(): void {
  if (installed) return;
  installed = true;
  // Drop any leftover XSS-readable token; new tokens stay memory-only (no read/migrate).
  clearLegacySessionToken();
  loadInjectedSession();
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!needsApiAuth(input)) return originalFetch(input, init);

    const token = readToken();
    const [firstInput, firstInit] = token ? withToken(input, init, token) : [input, init];
    const response = await originalFetch(firstInput, firstInit);
    if (response.status !== 401) return response;

    if (token) clearToken();
    const nextToken = await promptForToken();
    if (!nextToken) return response;

    storeToken(nextToken);
    const [retryInput, retryInit] = withToken(input, init, nextToken);
    const retry = await originalFetch(retryInput, retryInit);
    if (retry.status === 401) clearToken();
    return retry;
  };
}

/** Test-only: allow a fresh `installApiAuthFetch()` in the same module instance. */
export function resetApiAuthFetchForTests(): void {
  installed = false;
  memoryToken = null;
  memoryCsrfToken = null;
  memorySessionOrigin = null;
  promptInFlight = null;
}
