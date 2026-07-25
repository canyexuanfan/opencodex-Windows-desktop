import type { TFn } from "../i18n";
import { readJsonIfOk } from "../fetch-json";
import type { CodexAccountEntry } from "./codex-account-pool-types";

export async function redeemResetCredit(
  apiBase: string,
  accountId: string,
  t: TFn,
  resetPopup: CodexAccountEntry | null,
  load: (refresh?: boolean) => Promise<boolean>,
): Promise<{ ok: boolean; toast?: string; close?: boolean }> {
  try {
    const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    if (!resp.ok) { alert(t("codexAuth.resetError")); return { ok: false }; }
    const result = await readJsonIfOk<{ code: string }>(resp);
    if (!result) { alert(t("codexAuth.resetError")); return { ok: false }; }
    if (result.code === "reset" || result.code === "already_redeemed") {
      const prevCredits = resetPopup?.quota?.resetCredits ?? 1;
      await load(true);
      return {
        ok: true,
        close: true,
        toast: t("codexAuth.resetSuccess", { remaining: String(Math.max(0, prevCredits - 1)) }),
      };
    }
    if (result.code === "nothing_to_reset") alert(t("codexAuth.resetNothingToReset"));
    else if (result.code === "no_credit") alert(t("codexAuth.resetNoCredit"));
    else alert(t("codexAuth.resetError"));
    return { ok: false };
  } catch {
    alert(t("codexAuth.resetError"));
    return { ok: false };
  }
}
