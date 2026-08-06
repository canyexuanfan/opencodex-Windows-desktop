export type UnknownEvidenceMode = "allow" | "penalize" | "exclude";
export type OptionalBoolean = "" | "true" | "false";

export type RoutingProfileCandidate = {
  provider: string;
  model: string;
};

export type RoutingProfileDto = {
  id: string;
  alias: string | null;
  model: string;
  revision: string;
  candidates: RoutingProfileCandidate[];
  require: {
    minContextWindow?: number;
    minQuotaHeadroom?: number;
    tools?: boolean;
    imageInput?: boolean;
    structuredOutput?: boolean;
    reasoningEffort?: string;
    serviceTier?: string;
    localOnly?: boolean;
    remoteAllowed?: boolean;
    encryptedCodexTasks?: boolean;
  };
  optimize: {
    latency: number;
    health: number;
    cost: number;
    quota: number;
  };
  limits: {
    maxEstimatedCostUsd?: number;
  };
  unknownEvidence: Record<"capability" | "health" | "quota" | "cost", UnknownEvidenceMode>;
};

export type RoutingProfileDraft = {
  id: string;
  alias: string;
  candidates: RoutingProfileCandidate[];
  require: {
    minContextWindow: string;
    minQuotaHeadroom: string;
    tools: OptionalBoolean;
    imageInput: OptionalBoolean;
    structuredOutput: OptionalBoolean;
    reasoningEffort: string;
    serviceTier: string;
    localOnly: OptionalBoolean;
    remoteAllowed: OptionalBoolean;
    encryptedCodexTasks: OptionalBoolean;
  };
  optimize: {
    latency: string;
    health: string;
    cost: string;
    quota: string;
  };
  limits: {
    maxEstimatedCostUsd: string;
  };
  unknownEvidence: Record<"capability" | "health" | "quota" | "cost", UnknownEvidenceMode>;
};

export type ModelOption = {
  provider: string;
  id: string;
};

const DEFAULT_OPTIMIZE = {
  latency: "0.55",
  health: "0.25",
  cost: "0.1",
  quota: "0.1",
} as const;

const DEFAULT_UNKNOWN_EVIDENCE = {
  capability: "exclude",
  health: "penalize",
  quota: "penalize",
  cost: "penalize",
} as const;

function optionalBoolean(value: boolean | undefined): OptionalBoolean {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

function numberInput(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function newRoutingProfileDraft(
  provider = "",
  model = "",
): RoutingProfileDraft {
  return {
    id: "",
    alias: "",
    candidates: [{ provider, model }],
    require: {
      minContextWindow: "",
      minQuotaHeadroom: "",
      tools: "",
      imageInput: "",
      structuredOutput: "",
      reasoningEffort: "",
      serviceTier: "",
      localOnly: "",
      remoteAllowed: "",
      encryptedCodexTasks: "",
    },
    optimize: { ...DEFAULT_OPTIMIZE },
    limits: { maxEstimatedCostUsd: "" },
    unknownEvidence: { ...DEFAULT_UNKNOWN_EVIDENCE },
  };
}

export function routingProfileDraftFromDto(profile: RoutingProfileDto): RoutingProfileDraft {
  return {
    id: profile.id,
    alias: profile.alias ?? "",
    candidates: profile.candidates.map(candidate => ({ ...candidate })),
    require: {
      minContextWindow: numberInput(profile.require.minContextWindow),
      minQuotaHeadroom: numberInput(profile.require.minQuotaHeadroom),
      tools: optionalBoolean(profile.require.tools),
      imageInput: optionalBoolean(profile.require.imageInput),
      structuredOutput: optionalBoolean(profile.require.structuredOutput),
      reasoningEffort: profile.require.reasoningEffort ?? "",
      serviceTier: profile.require.serviceTier ?? "",
      localOnly: optionalBoolean(profile.require.localOnly),
      remoteAllowed: optionalBoolean(profile.require.remoteAllowed),
      encryptedCodexTasks: optionalBoolean(profile.require.encryptedCodexTasks),
    },
    optimize: {
      latency: String(profile.optimize.latency),
      health: String(profile.optimize.health),
      cost: String(profile.optimize.cost),
      quota: String(profile.optimize.quota),
    },
    limits: {
      maxEstimatedCostUsd: numberInput(profile.limits.maxEstimatedCostUsd),
    },
    unknownEvidence: { ...profile.unknownEvidence },
  };
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
}

function draftBoolean(value: OptionalBoolean): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function routingProfilePutBody(draft: RoutingProfileDraft): {
  id: string;
  profile: Record<string, unknown>;
} {
  const require = compactRecord({
    minContextWindow: optionalNumber(draft.require.minContextWindow),
    minQuotaHeadroom: optionalNumber(draft.require.minQuotaHeadroom),
    tools: draftBoolean(draft.require.tools),
    imageInput: draftBoolean(draft.require.imageInput),
    structuredOutput: draftBoolean(draft.require.structuredOutput),
    reasoningEffort: draft.require.reasoningEffort.trim() || undefined,
    serviceTier: draft.require.serviceTier.trim() || undefined,
    localOnly: draftBoolean(draft.require.localOnly),
    remoteAllowed: draftBoolean(draft.require.remoteAllowed),
    encryptedCodexTasks: draftBoolean(draft.require.encryptedCodexTasks),
  });
  const maxEstimatedCostUsd = optionalNumber(draft.limits.maxEstimatedCostUsd);

  return {
    id: draft.id.trim(),
    profile: {
      ...(draft.alias.trim() ? { alias: draft.alias.trim() } : {}),
      candidates: draft.candidates.map(candidate => ({
        provider: candidate.provider.trim(),
        model: candidate.model.trim(),
      })),
      ...(Object.keys(require).length > 0 ? { require } : {}),
      optimize: {
        latency: Number(draft.optimize.latency),
        health: Number(draft.optimize.health),
        cost: Number(draft.optimize.cost),
        quota: Number(draft.optimize.quota),
      },
      ...(maxEstimatedCostUsd !== undefined
        ? { limits: { maxEstimatedCostUsd } }
        : {}),
      unknownEvidence: { ...draft.unknownEvidence },
    },
  };
}

export function routingProfileResponseError(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const error = (data as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

export function routingProfileResponseSucceeded(data: unknown): boolean {
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as { success?: unknown }).success === true;
}

export function modelOptionsForProvider(
  models: ModelOption[],
  provider: string,
): ModelOption[] {
  return models.filter(model => model.provider === provider);
}
