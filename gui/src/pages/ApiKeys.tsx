import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, LOCALES } from "../i18n/shared";
import ApiKeysWorkspace from "../components/apikeys-workspace/ApiKeysWorkspace";

interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export default function ApiKeys({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const creatingRef = useRef(false);

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`);
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys ?? []);
        setEndpoint(data.endpoint ?? "");
      }
    } catch { /* proxy down */ }
  }, [apiBase]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchKeys();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeys]);

  const responseEndpoint = endpoint || "http://127.0.0.1:10100/v1/responses";

  const handleCreate = async (name?: string): Promise<boolean> => {
    if (creatingRef.current) return false;
    creatingRef.current = true;
    setCreating(true);
    try {
      const effectiveName = name ?? newName;
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: effectiveName || "default" }),
      });
      if (!res.ok) return false;
      const data = await res.json() as { key?: unknown };
      if (typeof data.key !== "string" || data.key.length === 0) return false;
      setNewKey(data.key);
      setNewName("");
      void fetchKeys();
      return true;
    } catch {
      return false;
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`${apiBase}/api/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
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
    <section className="api-page">
      <div className="page-head">
        <h2>{t("api.title")}</h2>
      </div>
      <ApiKeysWorkspace
        keys={keys}
        endpoint={responseEndpoint}
        localeTag={localeTag}
        creating={creating}
        newKey={newKey}
        copied={copied}
        onCreate={name => handleCreate(name)}
        onDismissNewKey={() => setNewKey(null)}
        onCopyNewKey={copyKey}
        onDelete={id => { void handleDelete(id); }}
      />
    </section>
  );

}
