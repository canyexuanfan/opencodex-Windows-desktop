import { expect, test } from "bun:test";
import {
  PROXY_MARKER,
  claudeConfigDir,
  defaultAuthDetectDeps,
  detectClaudeAuth,
  type AuthDetectDeps,
  type AuthPresence,
} from "../src/claude/auth-detect";

/**
 * The safety contract: `unknown` must never collapse into `absent`, because that is
 * what would flip a subscriber into proxy mode on a denied keychain prompt.
 */

function deps(overrides: Partial<AuthDetectDeps> = {}): AuthDetectDeps {
  return {
    readClaudeJson: () => undefined,
    credentialsFileExists: () => false,
    keychainProbe: () => "absent" as AuthPresence,
    env: () => ({}),
    ...overrides,
  };
}

test("S1: an oauthAccount with an email is present", () => {
  const result = detectClaudeAuth(deps({
    readClaudeJson: () => ({ oauthAccount: { emailAddress: "user@example.com" } }),
  }));
  expect(result.presence).toBe("present");
  expect(result.foundBy).toBe("claude-json-oauth");
  // The detail line is UI copy and must never carry the address itself.
  expect(JSON.stringify(result.sources)).not.toContain("user@example.com");
});

test("S1: a missing file is absent, a corrupt file is unknown", () => {
  expect(detectClaudeAuth(deps()).presence).toBe("absent");
  const corrupt = detectClaudeAuth(deps({
    readClaudeJson: () => { throw new SyntaxError("Unexpected token"); },
  }));
  expect(corrupt.presence).toBe("unknown");
});

test("S1: an oauthAccount without a usable email is absent, not present", () => {
  expect(detectClaudeAuth(deps({ readClaudeJson: () => ({ oauthAccount: {} }) })).presence).toBe("absent");
  expect(detectClaudeAuth(deps({ readClaudeJson: () => ({ oauthAccount: { emailAddress: "  " } }) })).presence).toBe("absent");
});

test("S2: credentials file existence maps to present/absent, read errors to unknown", () => {
  expect(detectClaudeAuth(deps({ credentialsFileExists: () => true })).foundBy).toBe("claude-credentials-file");
  expect(detectClaudeAuth(deps({ credentialsFileExists: () => false })).presence).toBe("absent");
  const errored = detectClaudeAuth(deps({
    credentialsFileExists: () => { throw new Error("EACCES"); },
  }));
  expect(errored.presence).toBe("unknown");
});

test("S3: keychain present/absent/unknown pass through", () => {
  expect(detectClaudeAuth(deps({ keychainProbe: () => "present" })).foundBy).toBe("macos-keychain");
  expect(detectClaudeAuth(deps({ keychainProbe: () => "absent" })).presence).toBe("absent");
  expect(detectClaudeAuth(deps({ keychainProbe: () => "unknown" })).presence).toBe("unknown");
  const threw = detectClaudeAuth(deps({ keychainProbe: () => { throw new Error("spawn failed"); } }));
  expect(threw.presence).toBe("unknown");
});

test("S5: a user API key or auth token is present", () => {
  expect(detectClaudeAuth(deps({ env: () => ({ ANTHROPIC_API_KEY: "sk-ant-x" }) })).foundBy).toBe("exported-env");
  expect(detectClaudeAuth(deps({ env: () => ({ ANTHROPIC_AUTH_TOKEN: "user-token" }) })).foundBy).toBe("exported-env");
});

// THE feedback-loop guard: our own dummy must not read as user auth, or a proxy-mode
// launch would look authenticated on the next launch (devlog 002 §1).
test("S5: our own proxy marker is NOT auth, and is reported as stale", () => {
  const result = detectClaudeAuth(deps({ env: () => ({ ANTHROPIC_AUTH_TOKEN: PROXY_MARKER }) }));
  expect(result.presence).toBe("absent");
  expect(result.staleProxyMarker).toBe(true);
});

test("staleProxyMarker rides every aggregate branch", () => {
  const env = () => ({ ANTHROPIC_AUTH_TOKEN: PROXY_MARKER });
  expect(detectClaudeAuth(deps({ env, keychainProbe: () => "present" })).staleProxyMarker).toBe(true);
  expect(detectClaudeAuth(deps({ env, keychainProbe: () => "unknown" })).staleProxyMarker).toBe(true);
  expect(detectClaudeAuth(deps({ env })).staleProxyMarker).toBe(true);
});

test("aggregate: any present wins, unknown beats absent, all-absent is absent", () => {
  const mixed = detectClaudeAuth(deps({
    readClaudeJson: () => { throw new Error("corrupt"); },
    keychainProbe: () => "present",
  }));
  expect(mixed.presence).toBe("present");
  expect(mixed.foundBy).toBe("macos-keychain");

  expect(detectClaudeAuth(deps({ keychainProbe: () => "unknown" })).presence).toBe("unknown");
  expect(detectClaudeAuth(deps()).presence).toBe("absent");
});

// The F1 invariant, stated as its own test so it cannot be softened by accident.
test("every source unknown aggregates to unknown, NEVER absent", () => {
  const result = detectClaudeAuth(deps({
    readClaudeJson: () => { throw new Error("corrupt"); },
    credentialsFileExists: () => { throw new Error("EACCES"); },
    keychainProbe: () => "unknown",
    env: () => { throw new Error("no env"); },
  }));
  expect(result.presence).toBe("unknown");
  expect(result.presence).not.toBe("absent");
});

test("claudeConfigDir honours CLAUDE_CONFIG_DIR", () => {
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/alt-profile" })).toBe("/tmp/alt-profile");
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "   " })).toContain(".claude");
  expect(claudeConfigDir({})).toContain(".claude");
});

// The keychain probe must be metadata-only: -g and -w print password material.
test("the default keychain probe never asks for secret material", () => {
  const source = Bun.file(new URL("../src/claude/auth-detect.ts", import.meta.url));
  const text = require("node:fs").readFileSync(new URL("../src/claude/auth-detect.ts", import.meta.url), "utf8") as string;
  expect(source).toBeDefined();
  const probeBlock = text.slice(text.indexOf("keychainProbe()"), text.indexOf("env: () => env"));
  expect(probeBlock).toContain("find-generic-password");
  expect(probeBlock).not.toContain('"-w"');
  expect(probeBlock).not.toContain('"-g"');
});

test("defaultAuthDetectDeps binds env to the caller-supplied environment", () => {
  const real = defaultAuthDetectDeps({ ANTHROPIC_API_KEY: "sk-ant-from-base" });
  expect(real.env().ANTHROPIC_API_KEY).toBe("sk-ant-from-base");
  // And the production path aggregates from it.
  const result = detectClaudeAuth({ ...real, readClaudeJson: () => undefined, credentialsFileExists: () => false, keychainProbe: () => "absent" });
  expect(result.presence).toBe("present");
  expect(result.foundBy).toBe("exported-env");
});
