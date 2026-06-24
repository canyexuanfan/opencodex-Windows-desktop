import { useEffect, useRef, useState } from "react";
import { IconX } from "../icons";
import { useT } from "../i18n";

export default function AddCodexAccountModal({
  apiBase, onClose, onAdded,
}: {
  apiBase: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const [step, setStep] = useState<"pick" | "import">("pick");
  const [id, setId] = useState("");
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleImport = async () => {
    setError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError(t("codexAuth.importInvalidJson"));
      return;
    }
    const tokens = (parsed.tokens ?? parsed) as Record<string, unknown>;
    const accessToken = (tokens.access_token ?? tokens.accessToken) as string | undefined;
    const refreshToken = (tokens.refresh_token ?? tokens.refreshToken) as string | undefined;
    const accountId = (tokens.account_id ?? tokens.accountId ?? "") as string;
    if (!accessToken || !refreshToken) { setError(t("codexAuth.importMissingTokens")); return; }
    if (!id.trim()) { setError(t("codexAuth.importMissingId")); return; }

    setSaving(true);
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id.trim(), email: id.trim(), accessToken, refreshToken, chatgptAccountId: accountId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Failed");
        return;
      }
      onAdded();
      onClose();
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
        {step === "pick" && (
          <>
            <h3 style={{ marginBottom: 4 }}>{t("codexAuth.addTitle")}</h3>
            <p className="modal-desc">{t("codexAuth.addPickDesc")}</p>

            <button className="list-row" onClick={() => setStep("pick")} style={{ marginBottom: 8, opacity: 0.5, cursor: "default" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>🌐</span>
                <div>
                  <div className="title">{t("codexAuth.oauthLogin")}</div>
                  <div className="sub">{t("codexAuth.oauthDesc")}</div>
                </div>
              </div>
              <span className="badge badge-muted">Soon</span>
            </button>

            <button className="list-row" onClick={() => setStep("import")} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>📄</span>
                <div>
                  <div className="title">{t("codexAuth.importAuthJson")}</div>
                  <div className="sub">{t("codexAuth.importAuthJsonDesc")}</div>
                </div>
              </div>
            </button>

            <button className="btn btn-ghost" onClick={onClose} style={{ width: "100%" }}>
              {t("codexAuth.cancel")}
            </button>
          </>
        )}

        {step === "import" && (
          <>
            <div className="modal-head">
              <h3>{t("codexAuth.importAuthJson")}</h3>
              <button className="btn btn-icon btn-ghost" onClick={onClose}><IconX /></button>
            </div>

            <label className="field-label">{t("codexAuth.addIdLabel")}</label>
            <input
              className="input"
              placeholder="work, personal, team..."
              value={id}
              onChange={e => setId(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            <label className="field-label">{t("codexAuth.addJsonLabel")}</label>
            <textarea
              className="input"
              rows={7}
              placeholder={'{\n  "tokens": {\n    "access_token": "...",\n    "refresh_token": "...",\n    "account_id": "..."\n  }\n}'}
              value={json}
              onChange={e => setJson(e.target.value)}
              style={{ fontFamily: "var(--mono)", fontSize: 12, resize: "vertical", marginBottom: 12 }}
            />

            <p className="modal-desc">{t("codexAuth.addHelp")}</p>

            {error && <div className="notice notice-err">{error}</div>}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => { setStep("pick"); setError(""); }}>{t("codexAuth.back")}</button>
              <button className="btn btn-primary" onClick={handleImport} disabled={saving || !id.trim() || !json.trim()}>
                {saving ? "..." : t("codexAuth.importBtn")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
