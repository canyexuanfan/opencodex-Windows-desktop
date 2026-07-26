import { expect, test } from "bun:test";
import { buildClaudeEnv } from "../src/cli/claude";
import { PROXY_MARKER, type AuthDetectDeps, type AuthPresence } from "../src/claude/auth-detect";
import { authModeIntent, resolveClaudeAuthMode } from "../src/claude/auth-mode";
import { detectClaudeAuth } from "../src/claude/auth-detect";
import type { OcxConfig } from "../src/types";

/**
 * Auto is a RESOLUTION, not stored state: registering a Claude login changes the next
 * launch with no migration. A manual choice bypasses detection forever.
 */

function cfg(claudeCode?: OcxConfig["claudeCode"], apiKeys?: { key: string }[]): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    ...(claudeCode ? { claudeCode } : {}),
    ...(apiKeys ? { apiKeys } : {}),
  } as unknown as OcxConfig;
}

function detection(presence: AuthPresence, staleProxyMarker = false) {
  const deps: AuthDetectDeps = {
    readClaudeJson: () => (presence === "present" ? { oauthAccount: { emailAddress: "u@e.com" } } : undefined),
    credentialsFileExists: () => false,
    keychainProbe: () => (presence === "unknown" ? "unknown" : "absent"),
    env: () => (staleProxyMarker ? { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER } : {}),
  };
  return detectClaudeAuth(deps);
}

// Detector stubs for buildClaudeEnv: file/keychain sources only, so the env source
// still reads the real launch base (which is the point of the binding).
function fileAuth(presence: AuthPresence): Omit<Partial<AuthDetectDeps>, "env"> {
  return {
    readClaudeJson: () => (presence === "present" ? { oauthAccount: { emailAddress: "u@e.com" } } : undefined),
    credentialsFileExists: () => false,
    keychainProbe: () => (presence === "unknown" ? "unknown" : "absent"),
  };
}

test("auto resolves subscription when auth is present and proxy when absent", () => {
  expect(resolveClaudeAuthMode(cfg(), detection("present")).markerMode).toBe("subscription");
  expect(resolveClaudeAuthMode(cfg(), detection("present")).origin).toBe("auto-present");
  expect(resolveClaudeAuthMode(cfg(), detection("absent")).markerMode).toBe("proxy");
  expect(resolveClaudeAuthMode(cfg(), detection("absent")).origin).toBe("auto-absent");
});

// The safety rule: a failed read must not move a subscriber onto proxy.
test("auto with unknown detection keeps subscription behaviour", () => {
  const resolved = resolveClaudeAuthMode(cfg(), detection("unknown"));
  expect(resolved.markerMode).toBe("subscription");
  expect(resolved.origin).toBe("auto-unknown");
});

test("a manual choice survives every auth flip unchanged", () => {
  for (const presence of ["present", "absent", "unknown"] as AuthPresence[]) {
    expect(resolveClaudeAuthMode(cfg({ authMode: "proxy" }), detection(presence)).markerMode).toBe("proxy");
    expect(resolveClaudeAuthMode(cfg({ authMode: "proxy" }), detection(presence)).origin).toBe("manual");
    expect(resolveClaudeAuthMode(cfg({ authMode: "subscription" }), detection(presence)).markerMode).toBe("subscription");
  }
});

test("intent reports auto for an unset key", () => {
  expect(authModeIntent(cfg())).toBe("auto");
  expect(authModeIntent(cfg({ authMode: "proxy" }))).toBe("proxy");
  expect(authModeIntent(cfg({ authMode: "subscription" }))).toBe("subscription");
});

test("auto-absent injects the marker; auto-present does not", () => {
  const absent = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") });
  expect(absent.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);

  const present = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(present.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

// THE feedback loop: a marker left by a previous launch must not read as auth, and
// must not survive into a subscription launch.
test("a stale marker is stripped when the mode resolves subscription", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  // And with no token there is no host-managed assertion (the #253 class).
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
});

test("a stale marker is re-established when the mode still resolves proxy", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER },
    {},
    { authDetect: fileAuth("absent") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
});

// The ordering blocker: a stale marker must not suppress the configured admission key.
test("a stale marker never suppresses the admission key", () => {
  const env = buildClaudeEnv(
    cfg(undefined, [{ key: "admission-key" }]), 10100,
    { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("admission-key");
  // opencodex really does own authentication here, so the host flag is correct.
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

test("auto-subscription emits no host-managed assertion (#253 class)", () => {
  const env = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
});

test("auto-absent emits both the marker and the host assertion", () => {
  const env = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

// A user-exported API key is auth: detection sees it through the base-env binding,
// so no proxy token is injected and no auth-conflict warning is provoked.
test("an exported ANTHROPIC_API_KEY keeps the token slot untouched", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-user" },
    {},
    { authDetect: fileAuth("absent") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user");
});

test("manual proxy injects the marker even when auth is present", () => {
  const env = buildClaudeEnv(cfg({ authMode: "proxy" }), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
});

test("manual subscription withholds the marker even when auth is absent", () => {
  const env = buildClaudeEnv(cfg({ authMode: "subscription" }), 10100, {}, {}, { authDetect: fileAuth("absent") });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});
