import { afterEach, describe, expect, test } from "bun:test";
import { discoverAntigravityProject, refreshAntigravityToken } from "../src/oauth/google-antigravity";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

describe("antigravity project discovery", () => {
  test("loadCodeAssist returns the project (cloudaicompanionProject)", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-A" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-A");
  });

  test("extracts project from a nested {id} shape", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ project: { id: "proj-nested" } }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-nested");
  });

  test("falls back to onboardUser poll loop (not-done then done)", async () => {
    let onboardCalls = 0;
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 }); // no project
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        if (onboardCalls === 1) return new Response(JSON.stringify({ done: false }), { status: 200 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-onboarded" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBe("proj-onboarded");
    expect(onboardCalls).toBe(2);
  });

  test("returns undefined when onboardUser aborts with non-200", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) return new Response("nope", { status: 500 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverAntigravityProject("tok")).toBeUndefined();
  });
});

describe("antigravity refresh", () => {
  test("refreshes the access token and re-discovers project; never leaks the token in errors", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-R" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    const cred = await refreshAntigravityToken("refresh-tok");
    expect(cred.access).toBe("fresh-access");
    expect(cred.refresh).toBe("refresh-tok");
    expect(cred.projectId).toBe("proj-R");
  });

  test("refresh failure carries status only, not the response body", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) return new Response("invalid_grant secret-detail", { status: 400 });
      return new Response("no", { status: 404 });
    });
    let caught: Error | undefined;
    try { await refreshAntigravityToken("refresh-tok"); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("400");
    expect(caught!.message).not.toContain("secret-detail");
  });
});
