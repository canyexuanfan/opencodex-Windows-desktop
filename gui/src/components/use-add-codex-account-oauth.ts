import { useCallback, useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type { AddCodexAccountUiAction } from "./add-codex-account-reducer";
import type { TFn } from "../i18n";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";

export function useAddCodexAccountOAuth({
  apiBase,
  reauthAccountId,
  ui,
  dispatch,
  t,
}: {
  apiBase: string;
  reauthAccountId?: string;
  ui: {
    step: string;
    manualCodeState: string;
    manualCode: string;
    authUrl: string;
    flowId: string | null;
  };
  dispatch: Dispatch<AddCodexAccountUiAction>;
  t: TFn;
}) {
  const aliveRef = useRef(true);
  const pollErrorStreakRef = useRef(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowRef = useRef<string | null>(null);
  const manualCodeStateRef = useRef(ui.manualCodeState);
  const loginAbortRef = useRef<AbortController | null>(null);
  const startedReauthRef = useRef<string | null>(null);
  const onAddedRef = useRef<() => void>(() => {});
  const onCloseRef = useRef<() => void>(() => {});

  const manualCodeBusy = ui.manualCodeState === "submitting";
  const manualCodeWaiting = ui.manualCodeState === "waiting";

  useEffect(() => {
    manualCodeStateRef.current = ui.manualCodeState;
  }, [ui.manualCodeState]);
  useEffect(() => {
    flowRef.current = ui.flowId;
  }, [ui.flowId]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  }, []);

  const clearManualCode = useCallback(() => {
    dispatch({ type: "clear-manual-code" });
    pollErrorStreakRef.current = 0;
  }, [dispatch]);

  const cancelLogin = useCallback(async () => {
    clearManualCode();
    const flowId = flowRef.current;
    flowRef.current = null;
    dispatch({ type: "set-flow-id", flowId: null });
    dispatch({ type: "set-auth-url", authUrl: "" });
    stopPolling();
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    if (!flowId) return;
    await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId }),
    }).catch(() => {});
  }, [apiBase, clearManualCode, dispatch, stopPolling]);

  // Replay-safe under StrictMode: remount must revive aliveRef after the first cleanup.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      clearManualCode();
      aliveRef.current = false;
      loginAbortRef.current?.abort();
      loginAbortRef.current = null;
      const flowId = flowRef.current;
      flowRef.current = null;
      dispatch({ type: "set-flow-id", flowId: null });
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      if (flowId) {
        void fetch(`${apiBase}/api/codex-auth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId }),
        }).catch(() => {});
      }
    };
  }, [apiBase, clearManualCode, dispatch]);

  const bindCallbacks = useCallback((onAdded: () => void, onClose: () => void) => {
    onAddedRef.current = onAdded;
    onCloseRef.current = onClose;
  }, []);

  const closeModal = useCallback(() => {
    if (ui.step === "oauth-waiting") void cancelLogin();
    onCloseRef.current();
  }, [ui.step, cancelLogin]);

  const startOAuth = useCallback(async (requestedId?: string) => {
    clearManualCode();
    flowRef.current = null;
    dispatch({ type: "set-flow-id", flowId: null });
    const controller = new AbortController();
    loginAbortRef.current?.abort();
    loginAbortRef.current = controller;
    dispatch({ type: "reset-oauth-start" });
    pollErrorStreakRef.current = 0;
    try {
      const accountId = reauthAccountId ?? requestedId?.trim() ?? "";
      const requestLogin = () => fetch(`${apiBase}/api/codex-auth/login`, {
        signal: controller.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          reauthAccountId
            ? { id: reauthAccountId, reauth: true }
            : (accountId ? { id: accountId } : {}),
        ),
      });
      type LoginResponse = { url?: string; flowId?: string; error?: string; status?: string };
      let resp = await requestLogin();
      if (!aliveRef.current) return;
      if (resp.status === 409) {
        await fetch(`${apiBase}/api/codex-auth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!aliveRef.current || controller.signal.aborted) return;
        resp = await requestLogin();
        if (resp.status === 409) {
          dispatch({ type: "set-error", error: t("codexAuth.oauthAlreadyInProgress") });
          return;
        }
      }
      // Preserve structured `{ error }` bodies on non-2xx instead of collapsing to networkError.
      const data = await readJsonOrThrow<LoginResponse>(resp, t("modal.networkError"));
      if (!aliveRef.current || !data) return;
      if (data.url) {
        flowRef.current = data.flowId ?? null;
        dispatch({ type: "set-flow-id", flowId: data.flowId ?? null });
        dispatch({ type: "set-auth-url", authUrl: data.url });
        dispatch({ type: "set-step", step: "oauth-waiting" });
        stopPolling();
        const fid = data.flowId ?? "";
        const reauthQuery = reauthAccountId ? "&reauth=1" : "";
        const statusUrl = fid
          ? `${apiBase}/api/codex-auth/login-status?flowId=${encodeURIComponent(fid)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ""}${reauthQuery}`
          : `${apiBase}/api/codex-auth/login-status`;
        pollRef.current = setInterval(async () => {
          try {
            const stRes = await fetch(statusUrl);
            const st = await readJsonIfOk<{ status: string; error?: string }>(stRes);
            if (!aliveRef.current) return;
            if (!st) {
              pollErrorStreakRef.current += 1;
              if (pollErrorStreakRef.current >= 3) {
                dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthStatusRetrying"), statusTone: "warn" });
              }
              return;
            }
            pollErrorStreakRef.current = 0;
            if (manualCodeStateRef.current === "waiting") {
              dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthCodeSubmitted"), statusTone: "ok" });
            } else {
              dispatch({ type: "set-status-notice", statusNotice: "", statusTone: "ok" });
            }
            if (st.status === "done") {
              stopPolling();
              clearManualCode();
              flowRef.current = null;
              dispatch({ type: "set-flow-id", flowId: null });
              if (!aliveRef.current) return;
              onAddedRef.current();
              onCloseRef.current();
            } else if (st.status === "error" || st.status === "expired") {
              stopPolling();
              clearManualCode();
              flowRef.current = null;
              dispatch({ type: "set-flow-id", flowId: null });
              if (aliveRef.current) {
                if (!reauthAccountId) dispatch({ type: "set-step", step: "pick" });
                dispatch({ type: "set-error", error: st.error ?? "Login failed" });
              }
            }
          } catch {
            if (!aliveRef.current) return;
            pollErrorStreakRef.current += 1;
            if (pollErrorStreakRef.current >= 3) {
              dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthStatusRetrying"), statusTone: "warn" });
            }
          }
        }, 2000);
        timeoutRef.current = setTimeout(() => {
          if (pollRef.current) {
            clearManualCode();
            void cancelLogin();
            if (aliveRef.current) {
              if (!reauthAccountId) dispatch({ type: "set-step", step: "pick" });
              dispatch({ type: "set-error", error: t("modal.loginTimeout") });
            }
          }
        }, 300_000);
      }
      if (data.error && !data.url) dispatch({ type: "set-error", error: data.error });
    } catch (e) {
      if (aliveRef.current && !(e instanceof Error && e.name === "AbortError")) {
        dispatch({ type: "set-error", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }, [apiBase, cancelLogin, clearManualCode, dispatch, reauthAccountId, stopPolling, t]);

  useEffect(() => {
    if (!reauthAccountId) {
      startedReauthRef.current = null;
      return;
    }
    if (startedReauthRef.current === reauthAccountId) return;
    startedReauthRef.current = reauthAccountId;
    void startOAuth();
  }, [reauthAccountId, startOAuth]);

  const copyLoginLink = async () => {
    if (!ui.authUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ui.authUrl);
      } else {
        const input = document.createElement("textarea");
        input.value = ui.authUrl;
        input.style.opacity = "0";
        input.style.position = "fixed";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      dispatch({ type: "set-copied", copied: true });
      setTimeout(() => { if (aliveRef.current) dispatch({ type: "set-copied", copied: false }); }, 2500);
    } catch {
      dispatch({ type: "set-error", error: t("codexAuth.loginLinkCopyFailed") });
    }
  };

  const submitManualCode = useCallback(async () => {
    const flowId = flowRef.current;
    const input = ui.manualCode.trim();
    if (!flowId || !input || manualCodeBusy || manualCodeWaiting) return;
    dispatch({ type: "set-manual-code-state", manualCodeState: "submitting" });
    dispatch({ type: "set-status-notice", statusNotice: "", statusTone: "ok" });
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId, input }),
      });
      if (!aliveRef.current) return;
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        dispatch({ type: "set-error", error: t("prov.pasteFail", { error: data.error ?? resp.statusText }) });
        dispatch({ type: "set-manual-code-state", manualCodeState: "idle" });
        return;
      }
      dispatch({ type: "oauth-code-submitted" });
      dispatch({ type: "set-status-notice", statusNotice: t("codexAuth.oauthCodeSubmitted"), statusTone: "ok" });
      pollErrorStreakRef.current = 0;
    } catch {
      if (aliveRef.current) {
        dispatch({ type: "set-error", error: t("modal.networkError") });
        dispatch({ type: "set-manual-code-state", manualCodeState: "idle" });
      }
    }
  }, [apiBase, dispatch, manualCodeBusy, manualCodeWaiting, t, ui.manualCode]);

  return {
    manualCodeBusy,
    manualCodeWaiting,
    bindCallbacks,
    closeModal,
    startOAuth,
    copyLoginLink,
    submitManualCode,
  };
}
