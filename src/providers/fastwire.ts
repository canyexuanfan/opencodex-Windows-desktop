import type { FastWire, OcxProviderConfig, TierDecision } from "../types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../types";
import type { InboundWire, ModelWireDefault } from "./registry";

const SERVICE_TIER_ADAPTERS = new Set(["openai-chat", "openai-responses"]);
const FAST_WIRE_ADAPTERS: Readonly<Record<FastWire["kind"], ReadonlySet<string>>> = {
  "service-tier": SERVICE_TIER_ADAPTERS,
  // A1 deliberately has no adapter implementation for Anthropic speed.
  "anthropic-speed": new Set(),
};

const DEFAULT_SERVICE_TIER_FAST_WIRE: FastWire = Object.freeze({
  kind: "service-tier" as const,
  canonicalToWire: Object.freeze({ priority: "priority" }),
  foreignCallerTiers: "verbatim" as const,
});

export type FastPolicyAuthTransport =
  | "oauth_bearer"
  | "forwarded_authorization"
  | "none"
  | "x_api_key"
  | "authorization_bearer";

export interface FastPolicyAuthority {
  readonly providerAdapter: string;
  readonly fastWireDeclaration: FastWire | null | undefined;
  readonly modelWireOverrideAllowed: boolean;
  readonly authTransport: FastPolicyAuthTransport;
  readonly capability: {
    readonly provider?: boolean;
    readonly models: Readonly<Record<string, boolean>>;
    readonly chatServiceTier?: boolean;
  };
  readonly modelAdapters: Readonly<Record<string, string>>;
  readonly hardPins: Readonly<Record<string, string>>;
  readonly registryWireDefaults: Readonly<Record<string, ModelWireDefault>>;
}

export interface ResolvedFastPolicy {
  readonly capability: boolean | undefined;
  readonly eligibility:
    | "eligible"
    | "capability-unsupported"
    | "unclassified"
    | "wire-unavailable"
    | "pin-unavailable";
  readonly adapter: string;
  readonly fastWire: FastWire | null;
  readonly forwardCallerTier: boolean;
}

function exactModelValue<T>(record: Readonly<Record<string, T>>, modelId: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

export function resolveProviderAuthTransport(
  adapter: string,
  mode: NonNullable<OcxProviderConfig["authMode"]>,
  apiKeyTransport?: OcxProviderConfig["apiKeyTransport"],
): FastPolicyAuthTransport {
  if (mode === "oauth") return "oauth_bearer";
  if (mode === "forward") return "forwarded_authorization";
  if (mode === "local") return "none";
  if (adapter === "anthropic" && apiKeyTransport !== "bearer") return "x_api_key";
  return "authorization_bearer";
}

/** Adapter-derived declaration. This runs only after the final model wire is known. */
export function defaultFastWireForAdapter(adapter: string): FastWire | null {
  return SERVICE_TIER_ADAPTERS.has(adapter) ? DEFAULT_SERVICE_TIER_FAST_WIRE : null;
}

function registryDefaultForModel(
  defaults: Readonly<Record<string, ModelWireDefault>>,
  modelId: string,
  inbound: InboundWire,
): string | undefined {
  const declared = defaults[modelId.trim().toLowerCase()];
  if (declared === undefined) return undefined;
  if (typeof declared !== "string" && !declared.inbound.includes(inbound)) return undefined;
  const wire = typeof declared === "string" ? declared : declared.wire;
  return MODEL_ADAPTER_OVERRIDE_ALLOWED.has(wire) ? wire : undefined;
}

function resolvePolicyAdapter(
  authority: FastPolicyAuthority,
  modelId: string,
  inbound: InboundWire,
): { adapter: string; hardPinned: boolean } {
  const hardPin = authority.hardPins[modelId];
  if (hardPin !== undefined) return { adapter: hardPin, hardPinned: true };
  if (authority.modelWireOverrideAllowed) {
    const configured = authority.modelAdapters[modelId];
    if (configured !== undefined && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(configured)) {
      return { adapter: configured, hardPinned: false };
    }
    if (MODEL_ADAPTER_OVERRIDE_ALLOWED.has(authority.providerAdapter)) {
      const registryDefault = registryDefaultForModel(authority.registryWireDefaults, modelId, inbound);
      if (registryDefault !== undefined) return { adapter: registryDefault, hardPinned: false };
    }
  }
  return { adapter: authority.providerAdapter, hardPinned: false };
}

/** A1's retained Chat serializer gate (`chatServiceTier || exact model true`). */
export function legacyChatEligibility(authority: FastPolicyAuthority, modelId: string): boolean {
  const exact = exactModelValue(authority.capability.models, modelId);
  if (authority.capability.provider === false || exact === false) return false;
  return authority.capability.chatServiceTier === true || exact === true;
}

export function resolveFastPolicy(
  authority: FastPolicyAuthority,
  modelId: string,
  inbound: InboundWire = "responses",
): ResolvedFastPolicy {
  const { adapter, hardPinned } = resolvePolicyAdapter(authority, modelId, inbound);
  const exactCapability = exactModelValue(authority.capability.models, modelId);
  const capability = authority.capability.provider === false
    ? false
    : exactCapability ?? authority.capability.provider;
  const fastWire = authority.fastWireDeclaration === undefined
    ? defaultFastWireForAdapter(adapter)
    : authority.fastWireDeclaration;
  const wireAvailable = fastWire !== null && FAST_WIRE_ADAPTERS[fastWire.kind].has(adapter);
  const chatEligible = adapter !== "openai-chat" || legacyChatEligibility(authority, modelId);
  // Explicit null disables Fast injection, but the defensive true+null branch still preserves
  // a caller tier on an existing OpenAI service-tier wire.
  const callerWireAvailable = wireAvailable
    || (fastWire === null && SERVICE_TIER_ADAPTERS.has(adapter));
  const forwardCallerTier = capability !== false && callerWireAvailable && chatEligible;

  let eligibility: ResolvedFastPolicy["eligibility"];
  if (capability === false) eligibility = "capability-unsupported";
  else if (!wireAvailable) {
    eligibility = hardPinned && authority.fastWireDeclaration !== null
      ? "pin-unavailable"
      : "wire-unavailable";
  }
  else if (!chatEligible) eligibility = "capability-unsupported";
  else if (capability === undefined) eligibility = "unclassified";
  else eligibility = "eligible";

  return { capability, eligibility, adapter, fastWire, forwardCallerTier };
}

export function canonicalFastTierMarker(callerTier: string | undefined): "priority" | undefined {
  const folded = callerTier?.trim().toLowerCase();
  return folded === "priority" || folded === "fast" ? "priority" : undefined;
}

/** Pure A1 tier state machine. It never changes a caller spelling on inherit. */
export function decideTier(
  policy: ResolvedFastPolicy,
  fastMode: boolean | undefined,
): TierDecision {
  if (policy.capability === false) return { kind: "drop" };
  if (policy.capability === undefined) {
    return policy.forwardCallerTier ? { kind: "forward-caller" } : { kind: "drop" };
  }
  if (policy.fastWire === null) {
    return policy.forwardCallerTier ? { kind: "forward-caller" } : { kind: "drop" };
  }
  if (policy.eligibility !== "eligible") return { kind: "drop" };
  if (fastMode === true) {
    const value = policy.fastWire.canonicalToWire.priority;
    return typeof value === "string" && value.length > 0
      ? { kind: "set", value }
      : { kind: "drop" };
  }
  if (fastMode === false) return { kind: "drop" };
  return { kind: "forward-caller" };
}

export function tierValueAfterDecision(
  decision: TierDecision,
  callerTier: string | undefined,
): string | undefined {
  if (decision.kind === "set") return decision.value;
  if (decision.kind === "drop") return undefined;
  return callerTier;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasFastWireCapabilityConflict(source: {
  readonly fastWire?: unknown;
  readonly supportsServiceTier?: unknown;
  readonly modelSupportsServiceTier?: unknown;
}): boolean {
  if (source.fastWire !== null) return false;
  if (source.supportsServiceTier === true) return true;
  return isPlainRecord(source.modelSupportsServiceTier)
    && Object.values(source.modelSupportsServiceTier).some(value => value === true);
}

/** Runtime registry validation; config uses the equivalent Zod shape at its boundary. */
export function fastWireDeclarationError(source: {
  readonly fastWire?: unknown;
  readonly supportsServiceTier?: unknown;
  readonly modelSupportsServiceTier?: unknown;
}): string | null {
  const value = source.fastWire;
  if (value === undefined) return null;
  if (hasFastWireCapabilityConflict(source)) {
    return "fastWire=null conflicts with supportsServiceTier=true";
  }
  if (value === null) return null;
  if (!isPlainRecord(value)) return "fastWire must be an object, null, or absent";
  if (value.kind !== "service-tier" && value.kind !== "anthropic-speed") {
    return "fastWire.kind must be service-tier or anthropic-speed";
  }
  if (value.foreignCallerTiers !== "verbatim" && value.foreignCallerTiers !== "drop") {
    return "fastWire.foreignCallerTiers must be verbatim or drop";
  }
  if (!isPlainRecord(value.canonicalToWire)) return "fastWire.canonicalToWire must be an object";
  if (!Object.prototype.hasOwnProperty.call(value.canonicalToWire, "priority")) {
    return "fastWire.canonicalToWire must include priority";
  }
  const wireValues: string[] = [];
  for (const wireValue of Object.values(value.canonicalToWire)) {
    if (typeof wireValue !== "string" || wireValue.trim().length === 0 || wireValue.trim().length > 64) {
      return "fastWire.canonicalToWire values must be nonblank strings of at most 64 characters";
    }
    wireValues.push(wireValue.trim());
  }
  if (new Set(wireValues).size !== wireValues.length) {
    return "fastWire.canonicalToWire values must be unique";
  }
  if (value.betas !== undefined) {
    if (!Array.isArray(value.betas) || value.betas.length > 16) {
      return "fastWire.betas must be an array of at most 16 values";
    }
    const betas: string[] = [];
    for (const beta of value.betas) {
      if (typeof beta !== "string" || beta.trim().length === 0) {
        return "fastWire.betas values must be nonblank strings";
      }
      betas.push(beta.trim());
    }
    if (new Set(betas).size !== betas.length) return "fastWire.betas values must be unique";
  }
  return null;
}
