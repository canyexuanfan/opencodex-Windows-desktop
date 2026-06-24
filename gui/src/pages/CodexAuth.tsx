import { useEffect, useState } from "react";
import { useT, type TFn } from "../i18n";
import { IconLock, IconPlus, IconX, IconAlert, IconRefresh } from "../icons";
import { Notice } from "../ui";
import AddCodexAccountModal from "../components/AddCodexAccountModal";

interface AccountQuota { weeklyPercent: number; fiveHourPercent: number; updatedAt: number }
interface AccountEntry {
  id: string; email: string; plan?: string; isMain: boolean;
  hasCredential: boolean; quota: AccountQuota | null;
  needsReauth?: boolean;
}

export default function CodexAuth({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [autoThreshold, setAutoThreshold] = useState(80);
  const [confirm, setConfirm] = useState<AccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState("");
  const [refreshingQuota, setRefreshingQuota] = useState(false);

  const load = async (refreshQuota = false) => {
    try {
      const [accts, active] = await Promise.all([
        fetch(`${apiBase}/api/codex-auth/accounts${refreshQuota ? "?refresh=1" : ""}`).then(r => r.json()),
        fetch(`${apiBase}/api/codex-auth/active`).then(r => r.json()),
      ]);
      setAccounts(accts.accounts ?? []);
      setActiveId(active.activeCodexAccountId ?? null);
      setAutoThreshold(active.autoSwitchThreshold ?? 80);
      return true;
    } catch {
      return false;
    }
  };
  useEffect(() => { load(); const iv = setInterval(load, 30_000); return () => clearInterval(iv); }, [apiBase]);

  const setActive = async (id: string | null) => {
    await fetch(`${apiBase}/api/codex-auth/active`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: id }),
    });
    setActiveId(id);
    setConfirm(null);
    const label = id ? accounts.find(a => a.id === id)?.email ?? id : "main";
    setToast(t("codexAuth.switched", { email: label }));
    setTimeout(() => setToast(""), 5000);
  };

  const remove = async (id: string) => {
    if (!window.confirm(t("codexAuth.removeConfirm", { id }))) return;
    await fetch(`${apiBase}/api/codex-auth/accounts?id=${id}`, { method: "DELETE" });
    load();
  };

  const toggleAuto = async () => {
    const next = autoThreshold > 0 ? 0 : 80;
    await fetch(`${apiBase}/api/codex-auth/auto-switch`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: next }),
    });
    setAutoThreshold(next);
  };

  const refreshQuotas = async () => {
    setRefreshingQuota(true);
    try {
      const ok = await load(true);
      setToast(t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed"));
      setTimeout(() => setToast(""), 5000);
    } finally {
      setRefreshingQuota(false);
    }
  };

  const main = accounts.find(a => a.isMain);
  const pool = accounts.filter(a => !a.isMain);
  const isNext = (id: string) => activeId === id;

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">{t("nav.codexAuth")}</h2>
        <button className="btn btn-sm btn-ghost" onClick={refreshQuotas} disabled={refreshingQuota}>
          <IconRefresh width={14} /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
        </button>
      </div>

      {toast && <Notice tone="ok">{toast}</Notice>}

      <div className={`card ${!activeId ? "card-active" : ""}`}
        onClick={() => activeId ? setConfirm({ id: "__main__", email: main?.email ?? "Codex App", plan: main?.plan, isMain: true, hasCredential: true, quota: main?.quota ?? null }) : undefined}
        style={{ cursor: activeId ? "pointer" : "default", marginBottom: 12 }}>
        <div className="card-head">
          <span className="dot dot-green" />
          <strong>{t("codexAuth.mainAccount")}</strong>
          <span className={`badge ${!activeId ? "badge-primary" : "badge-muted"}`}>
            {!activeId ? t("codexAuth.nextSession") : t("codexAuth.current")}
          </span>
          <span className="card-right"><IconLock width={14} /> {t("codexAuth.appLogin")}</span>
        </div>
        <div className="card-sub">{main?.email ?? "Codex App login"}{main?.plan ? ` · ${main.plan}` : ""}</div>
        {main?.quota && <QuotaBars quota={main.quota} t={t} />}
      </div>

      <div className="section-sep">
        <span className="section-label">{t("codexAuth.accountPool")}</span>
        <div className="sep-line" />
        <button className="btn btn-sm btn-ghost" onClick={() => setShowAdd(true)}>
          <IconPlus width={14} /> {t("codexAuth.add")}
        </button>
      </div>

      {pool.length === 0 && <p className="empty">{t("codexAuth.noPool")}</p>}

      {pool.map(a => (
        <div key={a.id} className={`card ${isNext(a.id) ? "card-active" : ""}`}
          onClick={() => !a.needsReauth && setConfirm(a)} style={{ cursor: a.needsReauth ? "default" : "pointer", marginBottom: 8 }}>
          <div className="card-head">
            <span className={`dot ${a.needsReauth ? "dot-amber" : isNext(a.id) ? "dot-blue" : "dot-muted"}`} />
            <strong>{a.email}</strong>
            {a.plan && <span className="badge badge-green">{a.plan}</span>}
            {a.needsReauth && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
            {isNext(a.id) && !a.needsReauth && <span className="badge badge-primary">{t("codexAuth.nextSession")}</span>}
            <button
              className="btn-icon btn-icon-danger card-right"
              aria-label={t("common.remove")}
              onClick={e => { e.stopPropagation(); remove(a.id); }}
            >
              <IconX width={14} />
            </button>
          </div>
          {a.needsReauth
            ? <div className="card-sub faint">{t("codexAuth.tokenExpired")}</div>
            : <QuotaBars quota={a.quota} t={t} />}
        </div>
      ))}

      <div className="card card-row" style={{ marginTop: 16 }}>
        <div>
          <strong>{t("codexAuth.autoSwitch")}</strong>
          <div className="card-sub">{t("codexAuth.autoSwitchDesc")}</div>
        </div>
        <button className={`toggle ${autoThreshold > 0 ? "on" : ""}`} onClick={toggleAuto}>
          <span className="toggle-knob" />
        </button>
      </div>

      {confirm && (
        <div className="modal-overlay" onClick={() => setConfirm(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <h3>{confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</h3>
            <p className="modal-desc">
              {confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
            </p>
            <div className="card" style={{ margin: "12px 0" }}>
              <strong>{confirm.id === "__main__" ? main?.email : confirm.email}</strong>
              {confirm.plan && <span className="badge badge-green" style={{ marginLeft: 8 }}>{confirm.plan}</span>}
            </div>
            {confirm.id !== "__main__" && (
              <div className="notice-warn"><IconAlert width={14} /> {t("codexAuth.cacheWarning")}</div>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>{t("codexAuth.cancel")}</button>
              <button className="btn btn-primary" onClick={() => setActive(confirm.id === "__main__" ? null : confirm.id)}>
                {t("codexAuth.setAsNext")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <AddCodexAccountModal
          apiBase={apiBase}
          onClose={() => setShowAdd(false)}
          onAdded={() => { load(); setToast(t("codexAuth.accountAdded")); setTimeout(() => setToast(""), 5000); }}
        />
      )}
    </div>
  );
}

function QuotaBars({ quota, t }: { quota: AccountQuota | null; t: TFn }) {
  if (!quota) return null;
  const wColor = quota.weeklyPercent >= 80 ? "bar-amber" : "bar-green";
  const hColor = quota.fiveHourPercent >= 80 ? "bar-amber" : "bar-green";
  return (
    <div className="quota-bars">
      <div className="quota-row">
        <span className="quota-label">{t("codexAuth.weekly")}</span>
        <div className="bar"><div className={`bar-fill ${wColor}`} style={{ width: `${quota.weeklyPercent}%` }} /></div>
        <span className="quota-val">{Math.round(quota.weeklyPercent)}%</span>
      </div>
      <div className="quota-row">
        <span className="quota-label">{t("codexAuth.fiveHour")}</span>
        <div className="bar"><div className={`bar-fill ${hColor}`} style={{ width: `${quota.fiveHourPercent}%` }} /></div>
        <span className="quota-val">{Math.round(quota.fiveHourPercent)}%</span>
      </div>
    </div>
  );
}
