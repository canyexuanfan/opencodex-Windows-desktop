import { useCallback, useState } from "react";
import { useI18n } from "./i18n/shared";
import { requestCodexRestart } from "./codex-restart";
import type { CodexRestartCode } from "./codex-restart";

export interface CodexRestartController {
  restarting: boolean;
  /**
   * Resolves to the response code, or null when the user declined the confirm or
   * the call failed. Callers that refresh staleness state must treat BOTH
   * `stopped` and `nothing_running` as "no stale app-server remains" — the
   * second is the race where the target exited on its own, and refreshing on
   * only the first would leave a staleness banner up after a successful outcome.
   */
  restart: () => Promise<CodexRestartCode | null>;
}

/**
 * Shared restart action for the sidebar and the models page.
 *
 * The confirm is not ceremony: stopping an app-server can interrupt a Codex turn
 * that is running right now. That is precisely the consent the startup path
 * refuses to assume on the user's behalf (src/codex/app-server-processes.ts),
 * and a dashboard click is where the user gives it.
 */
export function useCodexRestart(apiBase: string): CodexRestartController {
  const { t } = useI18n();
  const [restarting, setRestarting] = useState(false);

  const restart = useCallback(async (): Promise<CodexRestartCode | null> => {
    if (!confirm(t("dash.codexRestartConfirm"))) return null;
    setRestarting(true);
    const outcome = await requestCodexRestart(apiBase, {
      formatFailure: status => t("dash.codexRestartFailed", { status: String(status) }),
      formatUnreachable: () => t("dash.codexRestartUnreachable"),
      formatMalformed: () => t("dash.codexRestartMalformed"),
    });
    setRestarting(false);

    if (!outcome.ok || !outcome.result) {
      alert(outcome.message);
      return null;
    }

    const result = outcome.result;
    if (result.code === "stopped") {
      alert(t("dash.codexRestartDone", { count: String(result.stopped.length) }));
    } else if (result.code === "nothing_running") {
      alert(t("dash.codexRestartNothing"));
    } else if (result.code === "enumeration_unavailable") {
      alert(t("dash.codexRestartUnknown"));
    } else {
      alert(t("dash.codexRestartPartial", { count: String(result.surviving.length) }));
    }
    return result.code;
  }, [apiBase, t]);

  return { restarting, restart };
}

