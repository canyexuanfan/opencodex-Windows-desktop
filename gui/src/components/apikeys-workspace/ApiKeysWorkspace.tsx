/**
 * ApiKeysWorkspace — rail + main workspace for the API Keys tab, mirroring the
 * Providers workspace DNA. Left rail lists active keys; the main pane shows either
 * the overview (endpoint, generate form, usage example) or a per-key detail view.
 */
import { useState } from "react";
import { IconCheck, IconPlus, IconTrash, IconX } from "../../icons";
import { useT } from "../../i18n";

export interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export interface ApiKeysWorkspaceProps {
  keys: ApiKeyEntry[];
  endpoint: string;
  localeTag?: string;
  creating: boolean;
  newKey: string | null;
  copied: boolean;
  onCreate: (name: string) => void;
  onDismissNewKey: () => void;
  onCopyNewKey: () => void;
  onDelete: (id: string) => void;
}

function formatCreatedDate(iso: string, localeTag?: string): string {
  return new Date(iso).toLocaleDateString(localeTag);
}

export default function ApiKeysWorkspace({
  keys,
  endpoint,
  localeTag,
  creating,
  newKey,
  copied,
  onCreate,
  onDismissNewKey,
  onCopyNewKey,
  onDelete,
}: ApiKeysWorkspaceProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = keys.find(k => k.id === selectedId) ?? null;

  const handleCreate = () => {
    onCreate(newName);
    setNewName("");
  };

  const handleDeleteClick = () => {
    if (!selected) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(selected.id);
    setConfirmDelete(false);
    setSelectedId(null);
  };

  return (
    <div className="apikeys-workspace-shell">
      <div className="apikeys-workspace-root">
        <aside className="apikeys-workspace-rail" aria-label={t("api.title")}>
          <div className="apikeys-workspace-rail-header">
            <span className="apikeys-workspace-rail-title">{t("api.activeKeys", { count: keys.length })}</span>
            <span className="apikeys-workspace-rail-count">{keys.length}</span>
          </div>
          <div className="apikeys-workspace-rail-list">
            {keys.length === 0 ? (
              <span className="apikeys-workspace-rail-empty">{t("api.workspace.noKeysHint")}</span>
            ) : (
              keys.map(k => (
                <button
                  key={k.id}
                  type="button"
                  className={`apikeys-workspace-rail-row${selectedId === k.id ? " apikeys-workspace-rail-row--selected" : ""}`}
                  onClick={() => { setSelectedId(k.id); setConfirmDelete(false); }}
                  aria-current={selectedId === k.id ? "true" : undefined}
                >
                  <span className="apikeys-workspace-rail-name">{k.name}</span>
                  <span className="apikeys-workspace-rail-meta">{k.prefix} · {formatCreatedDate(k.createdAt, localeTag)}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <main className="apikeys-workspace-main">
          {selected ? (
            <div className="awi-detail">
              <div className="awi-detail-head">
                <h2 className="awi-detail-title">{selected.name}</h2>
                <span className="awi-detail-actions">
                  {confirmDelete ? (
                    <>
                      <button type="button" className="btn btn-danger btn-sm" onClick={handleDeleteClick}>
                        <IconTrash /> {t("api.confirm")}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>
                        {t("common.cancel")}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-danger btn-sm" onClick={handleDeleteClick} aria-label={t("api.deleteAria")}>
                      <IconTrash /> {t("api.workspace.deleteKey")}
                    </button>
                  )}
                </span>
              </div>
              {confirmDelete && (
                <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{t("api.workspace.deleteConfirm")}</p>
              )}
              <div className="awi-section">
                <h3 className="awi-section-title">{t("api.workspace.keyDetails")}</h3>
                <dl className="awi-kv">
                  <div className="awi-kv-row">
                    <dt>{t("api.colName")}</dt>
                    <dd>{selected.name}</dd>
                  </div>
                  <div className="awi-kv-row">
                    <dt>{t("api.workspace.keyPrefix")}</dt>
                    <dd><code>{selected.prefix}</code></dd>
                  </div>
                  <div className="awi-kv-row">
                    <dt>{t("api.colCreated")}</dt>
                    <dd>{formatCreatedDate(selected.createdAt, localeTag)}</dd>
                  </div>
                </dl>
              </div>
            </div>
          ) : (
            <>
              {keys.length > 0 && (
                <div className="awi-hint">{t("api.workspace.selectKeyHint")}</div>
              )}

              {newKey && (
                <div className="awi-newkey">
                  <h3 className="awi-newkey-title">{t("api.newKeyTitle")}</h3>
                  <p className="awi-newkey-note">{t("api.newKeyNote")}</p>
                  <div className="awi-newkey-row">
                    <code className="awi-newkey-code">{newKey}</code>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={onCopyNewKey}>
                      {copied ? <><IconCheck /> {t("api.copied")}</> : t("api.copy")}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={onDismissNewKey} aria-label={t("api.dismiss")}>
                      <IconX />
                    </button>
                  </div>
                </div>
              )}

              <div className="awi-section">
                <h3 className="awi-section-title">{t("api.endpoint")}</h3>
                <code className="awi-endpoint">{endpoint}</code>
                <p className="awi-endpoint-note">{t("api.endpointNote")}</p>
              </div>

              <div className="awi-section">
                <h3 className="awi-section-title">{t("api.generateTitle")}</h3>
                <div className="awi-generate-row">
                  <input
                    type="text"
                    className="input"
                    placeholder={t("api.keyNamePlaceholder")}
                    aria-label={t("api.keyNamePlaceholder")}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
                  />
                  <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={creating}>
                    <IconPlus /> {creating ? t("api.generating") : t("api.generate")}
                  </button>
                </div>
              </div>

              <div className="awi-section">
                <h3 className="awi-section-title">{t("api.usageTitle")}</h3>
                <pre className="awi-usage-pre">{`curl ${endpoint} \\
  -H "Authorization: Bearer ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Hello, world!"
  }'`}</pre>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
