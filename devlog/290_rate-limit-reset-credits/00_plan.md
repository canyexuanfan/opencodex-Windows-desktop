# 290 Rate-Limit Reset Credits — Implementation Plan

## Objective

Add Codex rate-limit reset credit viewing and redemption to opencodex.
Users can see how many banked reset credits each pool account has,
and redeem them from the CLI (`ocx usage`) or Dashboard GUI (CodexAuth tab).

Pool-aware: every account in `codex-accounts.json` is independently queryable
and redeemable, using each account's own OAuth credentials.

## Background

Codex app v26.609+ / CLI v0.135+ added self-service rate-limit reset credits
(PR #28143, #28154). Users earn credits (monthly baseline + referral program)
and redeem them to instantly reset their hourly/weekly usage windows.

**Source of truth**: commits `bef99f861` and `f8f5a6e78` in `openai/codex`.

### API Contract (from codex-rs)

**Read credits** — already called by opencodex:

```
GET https://chatgpt.com/backend-api/wham/usage
Headers: Authorization: Bearer <accessToken>
         ChatGPT-Account-Id: <chatgptAccountId>

Response (new field):
{
  ...existing rate_limit fields...,
  "rate_limit_reset_credits": {        // nullable — absent for old backends
    "available_count": 2               // integer
  }
}
```

**Consume a credit**:

```
POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume
Headers: Authorization: Bearer <accessToken>
         ChatGPT-Account-Id: <chatgptAccountId>
Content-Type: application/json
Body: { "redeem_request_id": "<UUID v4>" }

Response:
{
  "code": "reset"              // success
       | "nothing_to_reset"    // no window eligible
       | "no_credit"           // 0 credits
       | "already_redeemed"    // same UUID already used
}
```

**Timeout**: 10 seconds (codex-rs constant).

## Classification

C2 (Ordinary Product Slice): single feature — read endpoint already called,
add one new POST proxy + extend existing types + GUI component.
No public API contract change (internal dashboard/CLI only).

## Phase Map

| Phase | Scope | Deliverable |
|-------|-------|-------------|
| **Phase 1** | Backend types + API proxy | `WhamUsageResponse` extension, consume proxy route, `codex-auth-api.ts` endpoint |
| **Phase 2** | CLI `ocx usage` enhancement | Show reset credits in `ocx usage`, add `ocx reset-limit` subcommand |
| **Phase 3** | Dashboard GUI | CodexAuth.tsx reset credit display + redeem button per account |
| **Phase 4** | Tests | Unit tests for parsing, proxy, CLI output |

---

## Phase 1 — Backend Types + API Proxy

### 1.1 MODIFY `src/codex-quota.ts`

Extend `WhamUsageResponse` to include reset credits:

```typescript
// BEFORE (line 11-19)
export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
};

// AFTER
export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: { used_percent?: number; reset_at?: number };
    secondary_window?: { used_percent?: number; reset_at?: number };
    tertiary_window?: { used_percent?: number; reset_at?: number };
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};
```

Extend `StoredAccountQuota` to store reset credit count:

```typescript
// BEFORE (line 1-9)
export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  updatedAt: number;
};

// AFTER — add one field
export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;           // NEW: banked reset credits (0 = none, undefined = not fetched)
  updatedAt: number;
};
```

Update `parseUsageQuota()` to capture the new field:

```typescript
// AFTER existing parsing (around line 127)
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;
```

Update `updateAccountQuota()` signature to accept `resetCredits`:

```typescript
// Add optional parameter + store it
export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  fiveHour: unknown,
  weeklyResetAt?: unknown,
  fiveHourResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,          // NEW
): void {
  // ... existing code ...
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;
  accountQuota.set(accountId, quota);
}
```

### 1.2 MODIFY `src/codex-auth-api.ts`

Update `fetchPoolAccountQuota()` and `fetchMainAccountInfo()` to pass
`resetCredits` through:

```typescript
// In fetchPoolAccountQuota() (line ~143-153)
    const quota = parseUsageQuota(data);
    if (!quota) return { quota: existing ?? null, needsReauth: false };
    updateAccountQuota(
      accountId,
      quota.weeklyPercent,
      quota.fiveHourPercent,
      quota.weeklyResetAt,
      quota.fiveHourResetAt,
      quota.monthlyPercent,
      quota.monthlyResetAt,
      quota.resetCredits,          // NEW
    );
```

Add new consume endpoint handler inside `handleCodexAuthAPI()`:

```typescript
// NEW route: POST /api/codex-auth/reset-credits/consume
if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
  const body = await req.json() as { accountId: string };
  if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);

  try {
    const { accessToken, chatgptAccountId } = await getValidCodexToken(body.accountId);
    const idempotencyKey = crypto.randomUUID();
    const resp = await fetch(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-Id": chatgptAccountId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ redeem_request_id: idempotencyKey }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return jsonResponse({ error: `Upstream error ${resp.status}`, detail: text }, resp.status);
    }
    const result = await resp.json();
    // Refresh quota after successful consume
    if (result.code === "reset") {
      await fetchPoolAccountQuota(body.accountId, true);
    }
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}
```

### 1.3 MODIFY `src/server.ts` (or `src/router.ts`)

Route the new endpoint — confirm which file handles `/api/codex-auth/*` routing
and add the path if not auto-dispatched by `handleCodexAuthAPI`.

---

## Phase 2 — CLI Enhancement

### 2.1 MODIFY `src/cli.ts`

Add `ocx usage` subcommand (or enhance existing status output):

```
$ ocx usage

  Codex Account Usage
  ─────────────────────────────────────────
  Main (user@example.com, Pro)
    5h:     ████████░░  80%   resets 14:35
    Weekly: ██░░░░░░░░  20%   resets Mon
    30d:    █░░░░░░░░░  10%   resets Jul 15
    Reset credits: 2 available

  Pool: work (work@corp.com, Plus)
    5h:     ██████████  100%  RATE LIMITED
    Weekly: ██████░░░░  60%   resets Mon
    30d:    ███░░░░░░░  30%   resets Jul 15
    Reset credits: 1 available
```

Add `ocx reset-limit <accountId>` subcommand:

```
$ ocx reset-limit work

  Redeeming 1 reset credit for "work" (work@corp.com)...
  ✓ Rate limit windows reset successfully.
  Remaining credits: 0

$ ocx reset-limit work
  ✗ No reset credits available for "work".
```

Implementation: HTTP call to `POST /api/codex-auth/reset-credits/consume`.

---

## Phase 3 — Dashboard GUI

### 3.1 MODIFY `gui/src/pages/CodexAuth.tsx`

Add reset credits display to each account card:

```tsx
// After existing QuotaRow components, before card footer
{account.quota?.resetCredits != null && account.quota.resetCredits > 0 && (
  <div className="reset-credits-row">
    <span className="reset-credits-label">{t("codexAuth.resetCredits")}</span>
    <span className="reset-credits-count">{account.quota.resetCredits}</span>
    <button
      className="reset-credits-btn"
      onClick={() => handleRedeemResetCredit(account.id)}
      disabled={redeemingAccount === account.id}
    >
      {redeemingAccount === account.id ? t("codexAuth.redeeming") : t("codexAuth.redeemReset")}
    </button>
  </div>
)}
```

Add redeem handler:

```tsx
const [redeemingAccount, setRedeemingAccount] = useState<string | null>(null);

async function handleRedeemResetCredit(accountId: string) {
  if (!confirm(t("codexAuth.confirmRedeem"))) return;
  setRedeemingAccount(accountId);
  try {
    const resp = await fetch("/api/codex-auth/reset-credits/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    const result = await resp.json();
    if (result.code === "reset") {
      // Success — refresh accounts to update quota display
      refreshAccounts();
    } else {
      alert(t(`codexAuth.resetOutcome.${result.code}`));
    }
  } catch {
    alert(t("codexAuth.resetError"));
  } finally {
    setRedeemingAccount(null);
  }
}
```

### 3.2 MODIFY `gui/src/i18n/en.ts`

```typescript
"codexAuth.resetCredits": "Reset credits",
"codexAuth.redeemReset": "Use reset",
"codexAuth.redeeming": "Resetting...",
"codexAuth.confirmRedeem": "Use 1 reset credit to clear your current rate limits?",
"codexAuth.resetOutcome.reset": "Rate limits reset successfully!",
"codexAuth.resetOutcome.nothing_to_reset": "No rate-limit window needs resetting right now.",
"codexAuth.resetOutcome.no_credit": "No reset credits available.",
"codexAuth.resetOutcome.already_redeemed": "This reset was already applied.",
"codexAuth.resetError": "Failed to redeem reset credit. Please try again.",
```

### 3.3 MODIFY `gui/src/styles.css`

```css
.reset-credits-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
}
.reset-credits-count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.reset-credits-btn {
  margin-left: auto;
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--accent);
  color: var(--bg);
  border: none;
  cursor: pointer;
}
.reset-credits-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

---

## Phase 4 — Tests

### 4.1 NEW `tests/rate-limit-reset-credits.test.ts`

Test cases:
1. `parseUsageQuota` correctly extracts `resetCredits` from `WhamUsageResponse`
2. `parseUsageQuota` returns `undefined` when field is absent (backward compat)
3. `updateAccountQuota` stores and retrieves `resetCredits`
4. Consume endpoint returns correct outcomes (mock fetch)
5. Consume refreshes quota after successful reset

---

## File Change Summary

| Action | File | Change |
|--------|------|--------|
| MODIFY | `src/codex-quota.ts` | Add `resetCredits` to types + parsing |
| MODIFY | `src/codex-auth-api.ts` | Pass `resetCredits` through + add consume endpoint |
| MODIFY | `src/cli.ts` | `ocx usage` + `ocx reset-limit` subcommands |
| MODIFY | `gui/src/pages/CodexAuth.tsx` | Reset credits display + redeem button |
| MODIFY | `gui/src/i18n/en.ts` | Translation keys |
| MODIFY | `gui/src/styles.css` | Reset credits styling |
| NEW    | `tests/rate-limit-reset-credits.test.ts` | Unit tests |

## Risks & Notes

1. **No actual credit consumed during development** — test with mocked responses only.
   Live testing requires a real Codex account with credits (do manually post-merge).
2. **Backend field availability** — `rate_limit_reset_credits` may be absent for older
   backends or non-Pro accounts. All parsing is nullable/optional.
3. **Idempotency** — UUID generated server-side per request. Retries use the same
   key only within the same HTTP request (no persistence needed).
4. **Workspace accounts** — codex-rs excludes workspace accounts from reset UI.
   opencodex should mirror this (check `plan_type` and skip if workspace).
