/**
 * Abstract base class for OAuth flows with local callback servers.
 * Ported from jawcode packages/ai/src/utils/oauth/callback-server.ts.
 *
 * Change vs source: the success/error page is an inline HTML constant. opencodex's GUI polls
 * GET /api/oauth/status, so it does not need OAuth state injected into the callback page.
 *
 * Handles: port allocation (preferred → random fallback), callback server, CSRF state,
 * manual-input race, 300s timeout. Providers implement generateAuthUrl() + exchangeToken().
 */
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_HOSTNAME = "localhost";
const DEFAULT_BIND_HOSTNAME = "127.0.0.1";
const CALLBACK_PATH = "/callback";

const SUCCESS_HTML =
  "<!doctype html><html><head><meta charset='utf-8'><title>opencodex</title></head>" +
  "<body style='font-family:system-ui,sans-serif;text-align:center;padding:4rem;color:#111'>" +
  "<h2>&#9989; Login complete</h2><p>You can close this tab and return to opencodex.</p></body></html>";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function errorHtml(message: string): string {
  return (
    "<!doctype html><html><head><meta charset='utf-8'><title>opencodex</title></head>" +
    "<body style='font-family:system-ui,sans-serif;text-align:center;padding:4rem;color:#111'>" +
    `<h2>&#9888; Login failed</h2><p>${escapeHtml(message)}</p></body></html>`
  );
}

export type CallbackResult = { code: string; state: string };

export interface OAuthCallbackFlowOptions {
  preferredPort: number;
  callbackPath?: string;
  callbackHostname?: string;
  /** Local listener hostname; defaults to callbackHostname when omitted. */
  callbackBindHostname?: string;
  /** Exact redirect URI advertised to the provider; disables port fallback. */
  redirectUri?: string;
}

type BunServer = ReturnType<typeof Bun.serve>;

export abstract class OAuthCallbackFlow {
  ctrl: OAuthController;
  preferredPort: number;
  callbackPath: string;
  callbackHostname: string;
  callbackBindHostname: string;
  redirectUri?: string;
  #callbackResolve?: (result: CallbackResult) => void;
  #callbackReject?: (error: string) => void;

  constructor(
    ctrl: OAuthController,
    preferredPortOrOptions: number | OAuthCallbackFlowOptions,
    callbackPath: string = CALLBACK_PATH,
  ) {
    this.ctrl = ctrl;
    if (typeof preferredPortOrOptions === "number") {
      this.preferredPort = preferredPortOrOptions;
      this.callbackPath = callbackPath;
      this.callbackHostname = DEFAULT_HOSTNAME;
      this.callbackBindHostname = DEFAULT_BIND_HOSTNAME;
      return;
    }
    this.preferredPort = preferredPortOrOptions.preferredPort;
    this.callbackPath = preferredPortOrOptions.callbackPath ?? CALLBACK_PATH;
    this.callbackHostname = preferredPortOrOptions.callbackHostname ?? DEFAULT_HOSTNAME;
    this.callbackBindHostname = preferredPortOrOptions.callbackBindHostname ?? DEFAULT_BIND_HOSTNAME;
    this.redirectUri = preferredPortOrOptions.redirectUri;
  }

  /** Build provider-specific authorization URL. */
  abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;

  /** Exchange authorization code for OAuth tokens. */
  abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

  /** Generate CSRF state token. */
  generateState(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Execute the OAuth login flow. */
  async login(): Promise<OAuthCredentials> {
    const state = this.generateState();
    const { server, redirectUri } = await this.#startCallbackServer(state);
    try {
      const { url: authUrl, instructions } = await this.generateAuthUrl(state, redirectUri);
      this.ctrl.onAuth?.({ url: authUrl, instructions });
      this.ctrl.onProgress?.("Waiting for browser authentication...");
      const { code } = await this.#waitForCallback(state);
      this.ctrl.onProgress?.("Exchanging authorization code for tokens...");
      return await this.exchangeToken(code, state, redirectUri);
    } finally {
      server.stop();
    }
  }

  async #startCallbackServer(expectedState: string): Promise<{ server: BunServer; redirectUri: string }> {
    try {
      const server = this.#createServer(this.preferredPort, expectedState);
      if (this.redirectUri) {
        return { server, redirectUri: this.redirectUri };
      }
      const redirectUri = `http://${this.callbackHostname}:${this.preferredPort}${this.callbackPath}`;
      return { server, redirectUri };
    } catch {
      if (this.redirectUri) {
        throw new Error(
          `OAuth callback port ${this.preferredPort} unavailable; cannot fall back to a random port when redirectUri is set`,
        );
      }
      const server = this.#createServer(0, expectedState);
      const actualPort = server.port;
      const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
      this.ctrl.onProgress?.(`Preferred port ${this.preferredPort} unavailable, using port ${actualPort}`);
      return { server, redirectUri };
    }
  }

  #createServer(port: number, expectedState: string): BunServer {
    return Bun.serve({
      hostname: this.callbackBindHostname,
      port,
      reusePort: false,
      fetch: (req: Request) => this.#handleCallback(req, expectedState),
    });
  }

  #handleCallback(req: Request, expectedState: string): Response {
    const url = new URL(req.url);
    if (url.pathname !== this.callbackPath) {
      return new Response("Not Found", { status: 404 });
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error") || "";
    const errorDescription = url.searchParams.get("error_description") || error;

    let ok = false;
    let consumeFlow = false;
    let errMessage = "";
    const stateMatches = !expectedState || state === expectedState;
    if (error) {
      errMessage = `Authorization failed: ${errorDescription}`;
      consumeFlow = stateMatches;
    } else if (!code) {
      errMessage = "Missing authorization code";
    } else if (!stateMatches) {
      errMessage = "State mismatch - possible CSRF attack";
    } else {
      ok = true;
      consumeFlow = true;
    }

    if (consumeFlow) {
      // Capture refs before they could be cleared, then resolve on the next microtask.
      const resolve = this.#callbackResolve;
      const reject = this.#callbackReject;
      queueMicrotask(() => {
        if (ok && code) {
          resolve?.({ code, state });
        } else {
          reject?.(errMessage || "Unknown error");
        }
      });
    }

    return new Response(ok ? SUCCESS_HTML : errorHtml(errMessage), {
      status: ok ? 200 : consumeFlow ? 500 : 400,
      headers: { "Content-Type": "text/html" },
    });
  }

  #waitForCallback(expectedState: string): Promise<CallbackResult> {
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT);
    const signal = this.ctrl.signal ? AbortSignal.any([this.ctrl.signal, timeoutSignal]) : timeoutSignal;

    const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
      this.#callbackResolve = resolve;
      this.#callbackReject = (e: string) => reject(new Error(e));

      signal.addEventListener("abort", () => {
        this.#callbackResolve = undefined;
        this.#callbackReject = undefined;
        reject(new Error(`OAuth callback cancelled: ${signal.reason}`));
      });
    });

    if (this.ctrl.onManualCodeInput) {
      const requestManualInput = this.ctrl.onManualCodeInput;
      const manualPromise = (async (): Promise<CallbackResult> => {
        while (true) {
          const result = await Promise.race([
            callbackPromise,
            requestManualInput()
              .then((input): CallbackResult | null => {
                const parsed = parseCallbackInput(input);
                if (!parsed.code) return null;
                if (expectedState && parsed.state !== expectedState) return null;
                return { code: parsed.code, state: parsed.state ?? "" };
              })
              .catch((): CallbackResult | null => null),
          ]);
          if (result) return result;
        }
      })();

      return Promise.race([callbackPromise, manualPromise]);
    }

    return callbackPromise;
  }
}

/** Parse a redirect URL or code string to extract code and state. */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL - check for query string format
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  // Assume raw code, possibly with state after #
  const [code, state] = value.split("#", 2);
  return { code, state };
}
