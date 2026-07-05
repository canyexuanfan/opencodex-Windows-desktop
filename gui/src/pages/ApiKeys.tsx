import { useEffect, useState } from "react";
import { IconPlus, IconX, IconCheck } from "../icons";

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`);
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys ?? []);
        setEndpoint(data.endpoint ?? "");
      }
    } catch { /* proxy down */ }
  };

  useEffect(() => { fetchKeys(); }, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName || "default" }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewKey(data.key);
        setNewName("");
        fetchKeys();
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`${apiBase}/api/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setConfirmDelete(null);
    fetchKeys();
  };

  const copyKey = () => {
    if (newKey) {
      navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <section className="page">
      <h2>API Access</h2>
      <p className="muted">
        Use generated API keys to access the opencodex proxy from external apps.
        Keys authenticate via <code>Authorization: Bearer ocx_...</code> or <code>x-opencodex-api-key</code> header.
      </p>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Endpoint</h3>
        <code className="block">{endpoint || "http://127.0.0.1:10100/v1/responses"}</code>
        <p className="muted small">Compatible with OpenAI Responses API format.</p>
      </div>

      {newKey && (
        <div className="card highlight" style={{ marginTop: "1rem" }}>
          <h3>New Key Created</h3>
          <p className="muted small">Copy this key now — it won't be shown again.</p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <code className="block" style={{ flex: 1, wordBreak: "break-all" }}>{newKey}</code>
            <button className="btn btn-sm" onClick={copyKey}>
              {copied ? <><IconCheck /> Copied</> : "Copy"}
            </button>
          </div>
          <button className="btn btn-sm" style={{ marginTop: "0.5rem" }} onClick={() => setNewKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Generate Key</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Key name (optional)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className="input"
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" onClick={handleCreate} disabled={creating}>
            <IconPlus /> {creating ? "Creating..." : "Generate"}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Active Keys ({keys.length})</h3>
        {keys.length === 0 ? (
          <p className="muted">No API keys yet. Generate one above.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Key</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code>{k.prefix}</code></td>
                  <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td>
                    {confirmDelete === k.id ? (
                      <span style={{ display: "flex", gap: "0.25rem" }}>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDelete(k.id)}>Confirm</button>
                        <button className="btn btn-sm" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button className="btn btn-sm" onClick={() => setConfirmDelete(k.id)}><IconX /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>Usage Example</h3>
        <pre className="block">{`curl ${endpoint || "http://127.0.0.1:10100"}/v1/responses \\
  -H "Authorization: Bearer ocx_YOUR_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Hello, world!"
  }'`}</pre>
      </div>
    </section>
  );
}
