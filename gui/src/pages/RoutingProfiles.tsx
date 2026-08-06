import { useCallback, useEffect, useRef, useState } from "react";
import {
  modelOptionsForProvider,
  newRoutingProfileDraft,
  routingProfileDraftFromDto,
  routingProfilePutBody,
  routingProfileResponseError,
  routingProfileResponseSucceeded,
  type ModelOption,
  type OptionalBoolean,
  type RoutingProfileDraft,
  type RoutingProfileDto,
  type UnknownEvidenceMode,
} from "../routing-profile-editor-data";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";

type DryRunCandidate = {
  provider: string;
  model: string;
  eligible: boolean;
  exclusions: Array<{ code: string; detail?: string }>;
  score?: { total: number; components: Record<string, number | undefined> };
};

type Analytics = {
  totalRequests: number;
  successRate: number | null;
  fallbackRate: number | null;
  confidence: string | null;
  historyTruncated: boolean;
  cooldownTriggeringFailures: number;
  durationMs: { p50?: number; p95?: number; p99?: number; sampleCount: number };
  firstOutputMs: { p50?: number; p95?: number; p99?: number; sampleCount: number; coverage: number | null };
  breakdown: Array<{ provider: string; model: string; requests: number; successRate: number | null; p50DurationMs?: number }>;
};

type DryRunResult = {
  candidates: DryRunCandidate[];
  selectedIndex: number | null;
  trace?: { profile?: { revision?: string } };
};

type ProviderDto = {
  disabled?: boolean;
  defaultModel?: string;
};

type ConfigDto = {
  providers?: Record<string, ProviderDto>;
};

const BOOLEAN_REQUIREMENTS = [
  "tools",
  "imageInput",
  "structuredOutput",
  "localOnly",
  "remoteAllowed",
  "encryptedCodexTasks",
] as const;
const STRING_REQUIREMENTS = ["reasoningEffort", "serviceTier"] as const;
const NUMERIC_REQUIREMENTS = ["minContextWindow", "minQuotaHeadroom"] as const;
const OPTIMIZE_KEYS = ["latency", "health", "cost", "quota"] as const;
const UNKNOWN_EVIDENCE_KEYS = ["capability", "health", "quota", "cost"] as const;
const UNKNOWN_EVIDENCE_OPTIONS: UnknownEvidenceMode[] = ["allow", "penalize", "exclude"];

function fmtMs(value: number | undefined, unavailable: string): string {
  return value === undefined ? unavailable : `${Math.round(value)}ms`;
}

function fmtRate(value: number | null | undefined, unavailable: string): string {
  return value === null || value === undefined ? unavailable : `${Math.round(value * 100)}%`;
}

function parseProfiles(raw: unknown): RoutingProfileDto[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const profiles = (raw as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((profile): profile is RoutingProfileDto => (
    !!profile
      && typeof profile === "object"
      && !Array.isArray(profile)
      && typeof (profile as { id?: unknown }).id === "string"
      && typeof (profile as { model?: unknown }).model === "string"
      && typeof (profile as { revision?: unknown }).revision === "string"
      && Array.isArray((profile as { candidates?: unknown }).candidates)
  )).map(profile => ({ ...profile, alias: profile.alias ?? null }));
}

function parseModels(raw: unknown): ModelOption[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models)
      ? (raw as { models: unknown[] }).models
      : [];
  const seen = new Set<string>();
  const models: ModelOption[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const provider = typeof (row as { provider?: unknown }).provider === "string"
      ? (row as { provider: string }).provider.trim()
      : "";
    const id = typeof (row as { id?: unknown }).id === "string"
      ? (row as { id: string }).id.trim()
      : "";
    if (!provider || !id || provider === "combo" || provider === "policy") continue;
    if ((row as { disabled?: unknown }).disabled === true) continue;
    const key = `${provider}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ provider, id });
  }
  return models;
}

function selectedAfterLoad(
  profiles: RoutingProfileDto[],
  currentId: string | null,
  preferredId?: string,
): RoutingProfileDto | null {
  const requestedId = preferredId ?? currentId;
  if (requestedId) {
    const match = profiles.find(profile => profile.id === requestedId);
    if (match) return match;
  }
  return profiles[0] ?? null;
}

export default function RoutingProfiles({ apiBase }: { apiBase: string }) {
  const t = useT();
  const unavailable = t("routing.unavailable");
  const [profiles, setProfiles] = useState<RoutingProfileDto[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<RoutingProfileDto | null>(null);
  const [draft, setDraft] = useState<RoutingProfileDraft | null>(null);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [context, setContext] = useState("");
  const [tools, setTools] = useState(false);
  const [image, setImage] = useState(false);
  const [structured, setStructured] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState("");
  const [running, setRunning] = useState(false);
  const selectedRef = useRef<RoutingProfileDto | null>(null);
  const loadGenerationRef = useRef(0);
  const dryRunGenerationRef = useRef(0);

  const notify = useCallback((message: string, ok: boolean) => {
    setStatus(message);
    setStatusOk(ok);
  }, []);

  useEffect(() => {
    if (!status || !statusOk) return;
    const timer = window.setTimeout(() => {
      setStatus("");
      setStatusOk(false);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [status, statusOk]);

  const clearDryRun = useCallback(() => {
    dryRunGenerationRef.current += 1;
    setDryRunResult(null);
    setDryRunError("");
    setRunning(false);
  }, []);

  const selectProfile = useCallback((profile: RoutingProfileDto | null) => {
    selectedRef.current = profile;
    setSelected(profile);
    setDraft(profile ? routingProfileDraftFromDto(profile) : null);
    setStatus("");
    setStatusOk(false);
    clearDryRun();
  }, [clearDryRun]);

  const load = useCallback(async (preferredId?: string) => {
    const generation = ++loadGenerationRef.current;
    setLoadError("");
    try {
      const [profilesRes, analyticsRes, configRes, modelsRes] = await Promise.all([
        fetch(`${apiBase}/api/routing-profiles`),
        fetch(`${apiBase}/api/routing-analytics`),
        fetch(`${apiBase}/api/config`),
        fetch(`${apiBase}/api/models`),
      ]);
      if (!profilesRes.ok) throw new Error(`load-${profilesRes.status}`);
      const [profilesJson, analyticsJson, configJson, modelsJson] = await Promise.all([
        profilesRes.json() as Promise<unknown>,
        analyticsRes.ok ? analyticsRes.json() as Promise<Analytics> : Promise.resolve(null),
        configRes.ok ? configRes.json() as Promise<ConfigDto> : Promise.resolve({} as ConfigDto),
        modelsRes.ok ? modelsRes.json() as Promise<unknown> : Promise.resolve([]),
      ]);
      if (generation !== loadGenerationRef.current) return;

      const nextProfiles = parseProfiles(profilesJson);
      const current = selectedRef.current;
      const refreshed = selectedAfterLoad(nextProfiles, current?.id ?? null, preferredId);
      const configuredProviders = configJson.providers ?? {};
      const nextProviderNames = Object.entries(configuredProviders)
        .filter(([, provider]) => provider.disabled !== true)
        .map(([name]) => name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const nextDefaults = Object.fromEntries(
        Object.entries(configuredProviders)
          .filter(([, provider]) => provider.disabled !== true && typeof provider.defaultModel === "string")
          .map(([name, provider]) => [name, provider.defaultModel!.trim()]),
      );

      selectedRef.current = refreshed;
      setProfiles(nextProfiles);
      setSelected(refreshed);
      setDraft(refreshed ? routingProfileDraftFromDto(refreshed) : null);
      setAnalytics(analyticsJson);
      setProviderNames(nextProviderNames);
      setProviderDefaults(nextDefaults);
      setModels(parseModels(modelsJson));
      if (!current || !refreshed || current.id !== refreshed.id || current.revision !== refreshed.revision) {
        clearDryRun();
      }
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [apiBase, clearDryRun]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const firstProvider = providerNames[0] ?? "";
  const firstModel = providerDefaults[firstProvider]
    ?? modelOptionsForProvider(models, firstProvider)[0]?.id
    ?? "";

  const startCreate = () => {
    selectedRef.current = null;
    setSelected(null);
    setDraft(newRoutingProfileDraft(firstProvider, firstModel));
    setStatus("");
    setStatusOk(false);
    clearDryRun();
  };

  const cancelEdit = () => {
    if (selected) {
      setDraft(routingProfileDraftFromDto(selected));
      setStatus("");
      setStatusOk(false);
      return;
    }
    selectProfile(profiles[0] ?? null);
  };

  const saveProfile = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setStatus("");
    setStatusOk(false);
    try {
      const body = routingProfilePutBody(draft);
      const response = await fetch(`${apiBase}/api/routing-profiles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null) as unknown;
      const serverError = routingProfileResponseError(data);
      if (!response.ok || serverError || !routingProfileResponseSucceeded(data)) {
        notify(serverError ?? t("routing.loadFailed"), false);
        return;
      }
      await load(body.id);
      notify(t("common.ok"), true);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("routing.loadFailed"), false);
    } finally {
      setSaving(false);
    }
  };

  const removeProfile = async () => {
    if (!selected || saving) return;
    if (!window.confirm(`${t("common.remove")} ${selected.id}?`)) return;
    setSaving(true);
    setStatus("");
    setStatusOk(false);
    try {
      const response = await fetch(
        `${apiBase}/api/routing-profiles?id=${encodeURIComponent(selected.id)}`,
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => null) as unknown;
      const serverError = routingProfileResponseError(data);
      if (!response.ok || serverError || !routingProfileResponseSucceeded(data)) {
        notify(serverError ?? t("routing.loadFailed"), false);
        return;
      }
      selectedRef.current = null;
      await load();
      notify(t("common.ok"), true);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("routing.loadFailed"), false);
    } finally {
      setSaving(false);
    }
  };

  const updateCandidate = (
    index: number,
    field: "provider" | "model",
    value: string,
  ) => {
    setDraft(current => {
      if (!current) return current;
      const candidates = current.candidates.map((candidate, candidateIndex) => {
        if (candidateIndex !== index) return candidate;
        if (field === "provider") {
          return {
            provider: value,
            model: providerDefaults[value]
              ?? modelOptionsForProvider(models, value)[0]?.id
              ?? "",
          };
        }
        return { ...candidate, model: value };
      });
      return { ...current, candidates };
    });
  };

  const addCandidate = () => {
    setDraft(current => current ? {
      ...current,
      candidates: [
        ...current.candidates,
        { provider: firstProvider, model: firstModel },
      ],
    } : current);
  };

  const removeCandidate = (index: number) => {
    setDraft(current => current ? {
      ...current,
      candidates: current.candidates.filter((_, candidateIndex) => candidateIndex !== index),
    } : current);
  };

  const runDryRun = async () => {
    if (!selected) return;
    const generation = ++dryRunGenerationRef.current;
    setRunning(true);
    setDryRunResult(null);
    setDryRunError("");
    try {
      const evidence: Record<string, number | boolean> = {};
      const contextTokens = context.trim() ? Number(context.trim()) : NaN;
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        evidence.contextWindow = contextTokens;
      }
      if (tools) evidence.toolsRequired = true;
      if (image) evidence.imageInputRequired = true;
      if (structured) evidence.structuredOutputRequired = true;
      const response = await fetch(`${apiBase}/api/routing-profiles/dry-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: selected.id,
          evidence,
        }),
      });
      if (generation !== dryRunGenerationRef.current) return;
      if (!response.ok) {
        const body = await response.json().catch(() => null) as unknown;
        if (generation !== dryRunGenerationRef.current) return;
        setDryRunError(routingProfileResponseError(body) ?? `dry-run ${response.status}`);
        return;
      }
      const result = await response.json() as DryRunResult;
      if (generation !== dryRunGenerationRef.current) return;
      setDryRunResult(result);
    } catch (error) {
      if (generation !== dryRunGenerationRef.current) return;
      setDryRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === dryRunGenerationRef.current) {
        setRunning(false);
      }
    }
  };

  const selectedModelOptions = draft?.candidates.map(
    candidate => modelOptionsForProvider(models, candidate.provider),
  ) ?? [];

  return (
    <div className="page" data-page="routing">
      <div className="page-head">
        <h2>{t("routing.title")}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={startCreate}>
            <span aria-hidden="true">+</span> {t("routing.detail")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>{t("common.retry")}</button>
        </div>
      </div>
      <p className="muted">{t("routing.subtitle")}</p>

      {loadError ? <Notice tone="err">{t("routing.loadFailed")}: {loadError}</Notice> : null}
      {status ? <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice> : null}

      {profiles.length > 0 ? (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {profiles.map(profile => (
            <button
              key={profile.id}
              type="button"
              className="model-card"
              style={{ textAlign: "left", cursor: "pointer" }}
              onClick={() => selectProfile(profile)}
              aria-pressed={selected?.id === profile.id}
            >
              <div className="card-badges">
                <strong>{profile.id}</strong>
                <span className="badge badge-muted">{profile.model}</span>
                <span className="badge badge-muted">{t("routing.revision")}: {profile.revision}</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}

      {draft ? (
        <form
          className="panel"
          style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}
          onSubmit={event => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <div className="page-head">
            <h3>{t("routing.detail")}: {selected?.model ?? <code>policy/…</code>}</h3>
            {selected ? <span className="badge badge-muted">{t("routing.revision")}: {selected.revision}</span> : null}
          </div>

          <div className="model-grid">
            <label className="field-label">
              <code>id</code>
              <input
                className="input"
                required
                disabled={selected !== null}
                value={draft.id}
                onChange={event => setDraft(current => current ? { ...current, id: event.target.value } : current)}
              />
            </label>
            <label className="field-label">
              <code>alias</code>
              <input
                className="input"
                value={draft.alias}
                onChange={event => setDraft(current => current ? { ...current, alias: event.target.value } : current)}
              />
            </label>
          </div>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.candidates")}</legend>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {draft.candidates.map((candidate, index) => {
                const candidateProviders = [...new Set([candidate.provider, ...providerNames])].filter(Boolean);
                const listId = `routing-model-options-${index}`;
                return (
                  <div key={`${index}-${candidate.provider}`} className="model-card">
                    <div className="model-grid">
                      <label className="field-label">
                        <code>provider</code>
                        <select
                          className="input"
                          required
                          value={candidate.provider}
                          onChange={event => updateCandidate(index, "provider", event.target.value)}
                        >
                          <option value="" disabled>{t("routing.none")}</option>
                          {candidateProviders.map(provider => <option key={provider} value={provider}>{provider}</option>)}
                        </select>
                      </label>
                      <label className="field-label">
                        <code>model</code>
                        <input
                          className="input"
                          required
                          list={listId}
                          value={candidate.model}
                          onChange={event => updateCandidate(index, "model", event.target.value)}
                        />
                        <datalist id={listId}>
                          {selectedModelOptions[index]?.map(model => <option key={model.id} value={model.id} />)}
                        </datalist>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={draft.candidates.length === 1}
                      onClick={() => removeCandidate(index)}
                    >
                      {t("common.remove")}
                    </button>
                  </div>
                );
              })}
              <button type="button" className="btn btn-ghost btn-sm" onClick={addCandidate}>
                <span aria-hidden="true">+</span> {t("routing.candidate")}
              </button>
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.require")}</legend>
            <div className="model-grid">
              {NUMERIC_REQUIREMENTS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <input
                    className="input"
                    type="number"
                    min={key === "minContextWindow" ? 1 : 0}
                    max={key === "minQuotaHeadroom" ? 1 : undefined}
                    step={key === "minContextWindow" ? 1 : "any"}
                    value={draft.require[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      require: { ...current.require, [key]: event.target.value },
                    } : current)}
                  />
                </label>
              ))}
              {STRING_REQUIREMENTS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <input
                    className="input"
                    value={draft.require[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      require: { ...current.require, [key]: event.target.value },
                    } : current)}
                  />
                </label>
              ))}
              {BOOLEAN_REQUIREMENTS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <select
                    className="input"
                    value={draft.require[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      require: {
                        ...current.require,
                        [key]: event.target.value as OptionalBoolean,
                      },
                    } : current)}
                  >
                    <option value="">{t("routing.none")}</option>
                    <option value="true">{t("routing.yes")}</option>
                    <option value="false">{t("routing.no")}</option>
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.optimize")}</legend>
            <div className="model-grid">
              {OPTIMIZE_KEYS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step="any"
                    required
                    value={draft.optimize[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      optimize: { ...current.optimize, [key]: event.target.value },
                    } : current)}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.limits")}</legend>
            <label className="field-label">
              <code>maxEstimatedCostUsd</code>
              <input
                className="input"
                type="number"
                min={0}
                step="any"
                value={draft.limits.maxEstimatedCostUsd}
                onChange={event => setDraft(current => current ? {
                  ...current,
                  limits: { maxEstimatedCostUsd: event.target.value },
                } : current)}
              />
            </label>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">{t("routing.unknownEvidence")}</legend>
            <div className="model-grid">
              {UNKNOWN_EVIDENCE_KEYS.map(key => (
                <label key={key} className="field-label">
                  <code>{key}</code>
                  <select
                    className="input"
                    value={draft.unknownEvidence[key]}
                    onChange={event => setDraft(current => current ? {
                      ...current,
                      unknownEvidence: {
                        ...current.unknownEvidence,
                        [key]: event.target.value as UnknownEvidenceMode,
                      },
                    } : current)}
                  >
                    {UNKNOWN_EVIDENCE_OPTIONS.map(mode => <option key={mode} value={mode}>{mode}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={cancelEdit}>
              {t("common.cancel")}
            </button>
            {selected ? (
              <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => void removeProfile()}>
                {t("common.remove")}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{t("routing.dryRun")}</h3>
        <label className="field-label" htmlFor="routing-context">
          {t("routing.dryRunContext")}
          <input
            id="routing-context"
            className="input"
            type="number"
            min={1}
            value={context}
            onChange={event => {
              setContext(event.target.value);
              clearDryRun();
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={tools}
            onChange={event => {
              setTools(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunTools")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={image}
            onChange={event => {
              setImage(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunImage")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={structured}
            onChange={event => {
              setStructured(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunStructured")}
        </label>
        <button type="button" className="btn btn-primary" disabled={!selected || running} onClick={() => void runDryRun()}>
          {t("routing.dryRunRun")}
        </button>
        {dryRunError ? <Notice tone="err">{dryRunError}</Notice> : null}
        {dryRunResult ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("routing.candidate")}</th>
                <th>{t("routing.eligible")}</th>
                <th>{t("routing.exclusions")}</th>
                <th>{t("routing.score")}</th>
              </tr>
            </thead>
            <tbody>
              {dryRunResult.candidates.map((candidate, index) => (
                <tr key={`${candidate.provider}/${candidate.model}`}>
                  <td>
                    {candidate.provider}/{candidate.model}
                    {index === dryRunResult.selectedIndex ? ` ✓ (${t("routing.selected")})` : ""}
                  </td>
                  <td>{candidate.eligible ? t("routing.yes") : t("routing.no")}</td>
                  <td>{candidate.exclusions.map(exclusion => exclusion.code).join(", ") || t("routing.none")}</td>
                  <td>{candidate.score ? candidate.score.total.toFixed(3) : unavailable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{t("routing.analytics")}</h3>
        {analytics ? (
          <>
            <div className="card-badges">
              <span className="badge badge-muted">{t("routing.analyticsTotal")}: {analytics.totalRequests}</span>
              <span className="badge badge-muted">{t("routing.analyticsSuccessRate")}: {fmtRate(analytics.successRate, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsFallbackRate")}: {fmtRate(analytics.fallbackRate, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP50")}: {fmtMs(analytics.durationMs.p50, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP95")}: {fmtMs(analytics.durationMs.p95, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP99")}: {fmtMs(analytics.durationMs.p99, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsCooldown")}: {analytics.cooldownTriggeringFailures}</span>
              <span className="badge badge-muted">{t("routing.analyticsConfidence")}: {analytics.confidence ?? unavailable}</span>
              {analytics.historyTruncated ? <span className="badge badge-muted">{t("routing.analyticsTruncated")}</span> : null}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("routing.candidate")}</th>
                  <th>{t("routing.analyticsRequests")}</th>
                  <th>{t("routing.analyticsSuccessRate")}</th>
                  <th>{t("routing.analyticsP50")}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.breakdown.map(row => (
                  <tr key={`${row.provider}/${row.model}`}>
                    <td>{row.provider}/{row.model}</td>
                    <td>{row.requests}</td>
                    <td>{fmtRate(row.successRate, unavailable)}</td>
                    <td>{fmtMs(row.p50DurationMs, unavailable)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">{t("routing.analyticsEmpty")}</p>
        )}
      </div>
    </div>
  );
}
