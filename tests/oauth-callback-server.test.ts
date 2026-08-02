import { describe, expect, test } from "bun:test";
import { OAuthCallbackFlow } from "../src/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";

class TestFlow extends OAuthCallbackFlow {
  async generateAuthUrl(): Promise<{ url: string }> {
    return { url: "https://example.test/auth" };
  }

  async exchangeToken(): Promise<OAuthCredentials> {
    return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
  }
}

const ctrl: OAuthController = {};

describe("OAuth callback server defaults", () => {
  test("binds callback listeners to numeric loopback by default", () => {
    const flow = new TestFlow(ctrl, 54545, "/callback");

    expect(flow.callbackHostname).toBe("localhost");
    expect(flow.callbackBindHostname).toBe("127.0.0.1");
  });

  test("keeps explicit callback bind hostname overrides", () => {
    const flow = new TestFlow(ctrl, {
      preferredPort: 54545,
      callbackPath: "/callback",
      callbackHostname: "localhost",
      callbackBindHostname: "127.0.0.1",
    });

    expect(flow.callbackBindHostname).toBe("127.0.0.1");
  });
});
