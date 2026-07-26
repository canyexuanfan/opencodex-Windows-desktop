import type { TFn } from "../i18n";
import { readJsonIfOk } from "../fetch-json";
import type { CodexAccountEntry } from "./codex-account-pool-types";

function remainingCreditsToast(
  t: TFn,
  remaining: number | undefined,
): string {
  if (remaining === undefined) return t("codexAuth.resetSuccessGeneric");
  return t("codexAuth.resetSuccess", { remaining: String(remaining) });
}

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
    const result = await readJsonIfOk<{ code: string; remaining?: number }>(resp);
    if (!result) return { ok: false, toast: t("codexAuth.resetError") };
    if (result.code === "reset" || result.code === "already_redeemed") {
      await load(true);
      const serverRemaining =
        typeof result.remaining === "number" && Number.isFinite(result.remaining)
          ? Math.max(0, result.remaining)
          : undefined;
      const knownCredits = resetPopup?.quota?.resetCredits;
      // Prefer server remaining. Never invent a decrement for already_redeemed / unknown counts.
      const remaining =
        serverRemaining
        ?? (result.code === "already_redeemed"
          ? (typeof knownCredits === "number" ? knownCredits : undefined)
          : (typeof knownCredits === "number" ? Math.max(0, knownCredits - 1) : undefined));
      return {
        ok: true,
        close: true,
        toast: result.code === "already_redeemed" && remaining === undefined
          ? t("codexAuth.resetAlreadyRedeemed")
          : remainingCreditsToast(t, remaining),
      };
    }
    const key = result.code === "nothing_to_reset" ? "codexAuth.resetNothingToReset"
      : result.code === "no_credit" ? "codexAuth.resetNoCredit"
      : "codexAuth.resetError";
    return { ok: false, close: true, toast: t(key) };
  } catch {
    return { ok: false, toast: t("codexAuth.resetError") };
  }
}
