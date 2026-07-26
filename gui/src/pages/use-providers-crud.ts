import { useCallback } from "react";
import type { TFn } from "../i18n/shared";
import type { ProviderUpdatePatch } from "../components/provider-workspace/types";
import { apiErrorMessage } from "../api-error";

export function useProvidersCrud({
  apiBase,
  t,
  removeBusyRef,
  workspaceSelected,
  setWorkspaceSelected,
  setRemoveConfirmName,
  notify,
  fetchConfig,
  fetchOauth,
  fetchProviderQuotas,
}: {
  apiBase: string;
  t: TFn;
  removeBusyRef: React.MutableRefObject<boolean>;
  workspaceSelected: string | null;
  setWorkspaceSelected: (name: string | null) => void;
  setRemoveConfirmName: (name: string | null) => void;
  notify: (msg: string, ok: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchOauth: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
}) {
  const removeProvider = useCallback(async (name: string) => {
    setRemoveConfirmName(name);
  }, [setRemoveConfirmName]);

  const confirmRemoveProvider = useCallback(async (removeConfirmName: string | null) => {
    const name = removeConfirmName;
    if (!name || removeBusyRef.current) return;
    removeBusyRef.current = true;
    setRemoveConfirmName(null);
    const fallback = t("prov.removeFail", { name });
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) {
        notify(t("prov.removed", { name }), true);
        if (workspaceSelected === name) setWorkspaceSelected(null);
        fetchConfig();
        fetchOauth();
        fetchProviderQuotas(true);
      } else {
        notify(await apiErrorMessage(res, fallback), false);
      }
    } catch {
      notify(fallback, false);
    } finally {
      removeBusyRef.current = false;
    }
  }, [apiBase, fetchConfig, fetchOauth, fetchProviderQuotas, notify, removeBusyRef, setRemoveConfirmName, setWorkspaceSelected, t, workspaceSelected]);

  const setProviderDisabled = useCallback(async (name: string, disabled: boolean) => {
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      notify(data.error || (disabled ? t("prov.disableFail", { name }) : t("prov.enableFail", { name })), false);
      return;
    }
    notify(disabled ? t("prov.disabled", { name }) : t("prov.enabled", { name }), true);
    fetchConfig();
    fetchOauth();
    fetchProviderQuotas(true);
  }, [apiBase, fetchConfig, fetchOauth, fetchProviderQuotas, notify, t]);

  const updateProvider = useCallback(async (name: string, patch: ProviderUpdatePatch): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        return { ok: false, error: data.error || "Update failed" };
      }
      // Await refresh so callers (e.g. notes editor) only leave edit mode once
      // item.note reflects the saved value.
      await fetchConfig();
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error" };
    }
  }, [apiBase, fetchConfig]);

  return { removeProvider, confirmRemoveProvider, setProviderDisabled, updateProvider };
}
