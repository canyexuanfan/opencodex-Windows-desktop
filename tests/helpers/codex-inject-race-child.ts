/**
 * A real second process that reaches the lock THROUGH `injectCodexConfig`.
 *
 * The existing lock child calls `withCodexWriteLock` directly with a fabricated
 * admission, which proves N and nothing about production. This one runs the
 * actual injection, so what it proves is that the production edge is the thing
 * contending.
 *
 * Prints exactly one JSON line so the parent asserts on a typed result rather
 * than scraping logs.
 */
import { injectCodexConfig } from "../../src/codex/inject";

const payload = JSON.parse(process.env.OCX_INJECT_RACE_PAYLOAD ?? "{}") as {
  port?: number;
  lockTimeoutMs?: number;
};

const result = await injectCodexConfig(payload.port ?? 10100, {}, {
  lockTimeoutMs: payload.lockTimeoutMs ?? 0,
});

console.log(JSON.stringify({
  success: result.success,
  retryable: (result as { retryable?: boolean }).retryable ?? false,
  message: result.message.slice(0, 200),
}));
