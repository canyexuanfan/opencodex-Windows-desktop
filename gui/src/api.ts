const TOKEN_KEY = "opencodex-api-token";

let installed = false;
let promptInFlight: Promise<string | null> | null = null;

function apiPath(input: RequestInfo | URL): string | null {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw, window.location.href).pathname;
  } catch {
    return null;
  }
}

function needsApiAuth(input: RequestInfo | URL): boolean {
  const path = apiPath(input);
  return !!path && (path.startsWith("/api/") || path.startsWith("/v1/"));
}

function readToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY)?.trim();
    return token || null;
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* session storage may be disabled */ }
}

function clearToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* session storage may be disabled */ }
}

function withToken(input: RequestInfo | URL, init: RequestInit | undefined, token: string): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("X-OpenCodex-API-Key", token);
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
