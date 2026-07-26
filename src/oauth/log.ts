// src/oauth/log.ts
import { maskAccountId } from "../lib/privacy";

const FORBIDDEN = /^(access|refresh|authorization|code|token|accessToken|refreshToken)$/i;

export function logOAuthEvent(
  event: string,
  fields: { provider: string; accountId?: string; [key: string]: unknown },
): void {
  const parts = [`[opencodex] ${event}`, `provider=${fields.provider}`];
  if (fields.accountId) parts.push(`account=${maskAccountId(fields.accountId)}`);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "provider" || key === "accountId") continue;
    if (FORBIDDEN.test(key)) continue;
    if (value === undefined) continue;
    parts.push(`${key}=${String(value)}`);
  }
  console.info(parts.join(" "));
}
