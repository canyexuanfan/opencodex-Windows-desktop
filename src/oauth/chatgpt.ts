import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";
import { generatePKCE } from "./pkce";

const CLIENT_ID = "DRivsnm2Mu42T3KOpqdtwB3NYviHYzwD";
const AUTH_URL = "https://auth0.openai.com/authorize";
const TOKEN_URL = "https://auth0.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access";
const AUDIENCE = "https://api.openai.com/v1";
const CALLBACK_PORT = 19191;
const CALLBACK_PATH = "/callback";

function credsFromToken(data: Record<string, unknown>): OAuthCredentials {
  return {
    access: data.access_token as string,
    refresh: (data.refresh_token as string) ?? "",
    expires: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
  };
}

export class ChatGPTOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";

  constructor(ctrl: OAuthController) {
    super(ctrl, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      callbackHostname: "127.0.0.1",
      callbackBindHostname: "127.0.0.1",
      redirectUri: `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`,
    });
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      audience: AUDIENCE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    });
    return {
      url: `${AUTH_URL}?${params}`,
      instructions: "Complete ChatGPT login in your browser.",
    };
  }

  async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
    if (!this.#verifier) throw new Error("ChatGPT PKCE verifier not initialized");
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: this.#verifier,
      }),
    });
    if (!resp.ok) throw new Error(`ChatGPT token exchange failed: ${resp.status}`);
    return credsFromToken((await resp.json()) as Record<string, unknown>);
  }
}

export async function loginChatGPT(ctrl: OAuthController): Promise<OAuthCredentials> {
  const flow = new ChatGPTOAuthFlow(ctrl);
  return flow.login();
}

export async function refreshChatGPTToken(refreshToken: string): Promise<OAuthCredentials> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) throw new Error(`ChatGPT refresh failed: ${resp.status}`);
  return credsFromToken((await resp.json()) as Record<string, unknown>);
}
