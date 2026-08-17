import { describe, expect, test } from "bun:test";

import { createResponsesPassthroughAdapter } from "../src/adapters/openai-responses";
import { validateConfigCandidate } from "../src/config";
import {
  canonicalFastTierMarker,
  decideTier,
  legacyChatEligibility,
  resolveFastPolicy,
  tierValueAfterDecision,
  type FastPolicyAuthority,
  type ResolvedFastPolicy,
} from "../src/providers/fastwire";
import { fastPolicyForModel } from "../src/providers/service-tier";
import { PROVIDER_REGISTRY, providerRegistryFastWireError } from "../src/providers/registry";
import type { FastWire, OcxConfig, OcxParsedRequest, TierDecision } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const MODEL = "model";
const SERVICE_WIRE: FastWire = {
  kind: "service-tier",
  canonicalToWire: { priority: "priority" },
  foreignCallerTiers: "verbatim",
};

type AdapterSource = "hard-pin" | "override" | "registry-default" | "provider-adapter";
type DeclarationState = "undefined" | "null" | "explicit";
type CapabilityState = "false" | "undefined" | "true";

function authorityForMatrix(args: {
  source: AdapterSource;
  declaration: DeclarationState;
  overrideAllowed: boolean;
  capability: CapabilityState;
  legacyChatEligible: boolean;
}): FastPolicyAuthority {
  const providerAdapter = args.source === "provider-adapter" ? "openai-chat" : "openai-responses";
  return {
    providerAdapter,
    fastWireDeclaration: args.declaration === "undefined"
      ? undefined
      : args.declaration === "null" ? null : SERVICE_WIRE,
    modelWireOverrideAllowed: args.overrideAllowed,
    authTransport: "authorization_bearer",
    capability: {
      ...(args.capability === "undefined" ? {} : { provider: args.capability === "true" }),
      models: {},
      chatServiceTier: args.legacyChatEligible,
    },
    modelAdapters: args.source === "hard-pin" || args.source === "override"
      ? { [MODEL]: args.source === "override" ? "openai-chat" : "openai-responses" }
      : {},
    hardPins: args.source === "hard-pin" ? { [MODEL]: "openai-chat" } : {},
    registryWireDefaults: args.source === "hard-pin" || args.source === "override"
      ? { [MODEL]: "openai-responses" }
      : args.source === "registry-default" ? { [MODEL]: "openai-chat" } : {},
  };
}

const policyMatrix = (["undefined", "null", "explicit"] as const).flatMap(declaration =>
  ([false, true] as const).flatMap(overrideAllowed =>
    (["hard-pin", "override", "registry-default", "provider-adapter"] as const).flatMap(source =>
      (["false", "undefined", "true"] as const).flatMap(capability =>
        ([false, true] as const).map(legacyChatEligible => ({
          declaration,
          overrideAllowed,
          source,
          capability,
          legacyChatEligible,
        })),
      ),
    ),
  ),
);

describe("resolveFastPolicy matrix", () => {
  test.each(policyMatrix)(
    "$declaration declaration, overrideAllowed=$overrideAllowed, $source, capability=$capability, legacy=$legacyChatEligible",
    row => {
      const authority = authorityForMatrix(row);
      const policy = resolveFastPolicy(authority, MODEL);
      const overrideCanWin = row.overrideAllowed && row.source !== "provider-adapter";
      const expectedAdapter = row.source === "hard-pin"
        ? "openai-chat"
        : overrideCanWin ? "openai-chat"
          : row.source === "provider-adapter" ? "openai-chat" : "openai-responses";
      const capability = row.capability === "undefined" ? undefined : row.capability === "true";
      const chatEligible = expectedAdapter !== "openai-chat" || row.legacyChatEligible;
      const wireAvailable = row.declaration !== "null";
      const expectedEligibility: ResolvedFastPolicy["eligibility"] = capability === false
        ? "capability-unsupported"
        : !wireAvailable
          ? "wire-unavailable"
          : !chatEligible
            ? "capability-unsupported"
            : capability === undefined ? "unclassified" : "eligible";

      expect(policy.adapter).toBe(expectedAdapter);
      expect(policy.capability).toBe(capability);
      expect(policy.eligibility).toBe(expectedEligibility);
      expect(policy.fastWire === null ? null : policy.fastWire?.kind).toBe(
        row.declaration === "null" ? null : "service-tier",
      );
      expect(policy.forwardCallerTier).toBe(capability !== false && chatEligible);
    },
  );

  test("registry defaults retain their inbound constraint", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "registry-default",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        legacyChatEligible: true,
      }),
      providerAdapter: "openai-responses",
      registryWireDefaults: { [MODEL]: { wire: "openai-chat", inbound: ["chat"] } },
    };
    expect(resolveFastPolicy(authority, MODEL, "chat").adapter).toBe("openai-chat");
    expect(resolveFastPolicy(authority, MODEL, "responses").adapter).toBe("openai-responses");
  });

  test("invalid configured overrides fall through to the captured registry default", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "registry-default",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        legacyChatEligible: true,
      }),
      modelAdapters: { [MODEL]: "anthropic" },
      registryWireDefaults: { [MODEL]: "openai-chat" },
    };
    expect(resolveFastPolicy(authority, MODEL).adapter).toBe("openai-chat");
  });

  test("registry defaults do not move a provider outside the allowed base-wire family", () => {
    const authority: FastPolicyAuthority = {
      ...authorityForMatrix({
        source: "registry-default",
        declaration: "undefined",
        overrideAllowed: true,
        capability: "true",
        legacyChatEligible: true,
      }),
      providerAdapter: "anthropic",
      registryWireDefaults: { [MODEL]: "openai-chat" },
    };
    expect(resolveFastPolicy(authority, MODEL).adapter).toBe("anthropic");
  });

  test("anthropic-speed has no A1 adapter mapping", () => {
    const policy = resolveFastPolicy({
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "explicit",
        overrideAllowed: true,
        capability: "true",
        legacyChatEligible: true,
      }),
      fastWireDeclaration: {
        kind: "anthropic-speed",
        canonicalToWire: { priority: "fast" },
        foreignCallerTiers: "drop",
        betas: ["fast-beta"],
      },
    }, MODEL);
    expect(policy).toMatchObject({ eligibility: "wire-unavailable", forwardCallerTier: false });
  });

  test("an incompatible hard pin reports pin-unavailable", () => {
    const policy = resolveFastPolicy({
      ...authorityForMatrix({
        source: "provider-adapter",
        declaration: "explicit",
        overrideAllowed: true,
        capability: "true",
        legacyChatEligible: true,
      }),
      hardPins: { [MODEL]: "anthropic" },
    }, MODEL);
    expect(policy).toMatchObject({ adapter: "anthropic", eligibility: "pin-unavailable" });
  });

  test("a missing provider name preserves the legacy provider-adapter short circuit", () => {
    const provider = {
      adapter: "anthropic",
      baseUrl: "https://fixture.example/v1",
      modelAdapters: { [MODEL]: "openai-responses" },
      supportsServiceTier: true,
    } as const;
    expect(fastPolicyForModel(provider, MODEL)).toMatchObject({
      adapter: "anthropic",
      capability: true,
      eligibility: "wire-unavailable",
    });
    expect(fastPolicyForModel(provider, MODEL, "fixture")).toMatchObject({
      adapter: "openai-responses",
      capability: true,
      eligibility: "eligible",
    });
  });
});

describe("legacyChatEligibility", () => {
  test.each([
    {
      label: "chatServiceTier opt-in",
      provider: undefined,
      models: {},
      chatServiceTier: true,
      expected: true,
    },
    {
      label: "case-insensitive exact-model opt-in",
      provider: undefined,
      models: { MODEL: true },
      chatServiceTier: false,
      expected: true,
    },
    {
      label: "provider false closes an exact-model opt-in",
      provider: false,
      models: { model: true },
      chatServiceTier: true,
      expected: false,
    },
    {
      label: "exact false closes a provider Chat opt-in",
      provider: true,
      models: { model: false },
      chatServiceTier: true,
      expected: false,
    },
  ])("$label", ({ provider, models, chatServiceTier, expected }) => {
    const authority = authorityForMatrix({
      source: "provider-adapter",
      declaration: "undefined",
      overrideAllowed: true,
      capability: "undefined",
      legacyChatEligible: false,
    });
    expect(legacyChatEligibility({
      ...authority,
      capability: { ...(provider === undefined ? {} : { provider }), models, chatServiceTier },
    }, MODEL)).toBe(expected);
  });
});

const tierGrid = ([false, undefined, true] as const).flatMap(support =>
  ([false, undefined, true] as const).flatMap(fastMode =>
    (["priority", "fast", "flex", undefined] as const).map(callerTier => ({
      support,
      fastMode,
      callerTier,
    })),
  ),
);

function tierPolicy(support: boolean | undefined): ResolvedFastPolicy {
  return {
    capability: support,
    eligibility: support === true ? "eligible" : support === false ? "capability-unsupported" : "unclassified",
    adapter: "openai-responses",
    fastWire: SERVICE_WIRE,
    forwardCallerTier: support !== false,
  };
}

describe("TierDecision state machine", () => {
  test.each(tierGrid)(
    "support=$support fastMode=$fastMode caller=$callerTier",
    ({ support, fastMode, callerTier }) => {
      const decision = decideTier(tierPolicy(support), fastMode);
      const expectedValue = support === false
        ? undefined
        : support === undefined ? callerTier
          : fastMode === true ? "priority" : fastMode === false ? undefined : callerTier;
      const expectedKind: TierDecision["kind"] = support === false || (support === true && fastMode === false)
        ? "drop"
        : support === true && fastMode === true ? "set" : "forward-caller";
      expect(decision.kind).toBe(expectedKind);
      expect(tierValueAfterDecision(decision, callerTier)).toBe(expectedValue);
      expect(canonicalFastTierMarker(callerTier)).toBe(
        callerTier === "priority" || callerTier === "fast" ? "priority" : undefined,
      );
    },
  );

  test.each(([false, undefined, true] as const).flatMap(fastMode =>
    (["priority", "fast", "flex", undefined] as const).map(callerTier => ({ fastMode, callerTier })),
  ))("true capability plus null wire preserves caller with fastMode=$fastMode caller=$callerTier", ({ fastMode, callerTier }) => {
    const decision = decideTier({
      capability: true,
      eligibility: "wire-unavailable",
      adapter: "openai-responses",
      fastWire: null,
      forwardCallerTier: true,
    }, fastMode);
    expect(decision).toEqual({ kind: "forward-caller" });
    expect(tierValueAfterDecision(decision, callerTier)).toBe(callerTier);
  });

  test.each(["Priority", "FAST", " fast "])("normalizes %s only into an internal marker", callerTier => {
    expect(canonicalFastTierMarker(callerTier)).toBe("priority");
    expect(tierValueAfterDecision({ kind: "forward-caller" }, callerTier)).toBe(callerTier);
  });
});

function configWithFastWire(fastWire: unknown, capability?: { provider?: boolean; exact?: boolean }): unknown {
  return {
    port: 10100,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://fixture.example/v1",
        fastWire,
        ...(capability?.provider === undefined ? {} : { supportsServiceTier: capability.provider }),
        ...(capability?.exact === undefined ? {} : { modelSupportsServiceTier: { [MODEL]: capability.exact } }),
      },
    },
  };
}

describe("FastWire config and registry validation", () => {
  test("accepts a complete declaration and trims its wire values", () => {
    const result = validateConfigCandidate(configWithFastWire({
      kind: "service-tier",
      canonicalToWire: { priority: " priority ", flex: " flex " },
      foreignCallerTiers: "verbatim",
      betas: [" beta-one "],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as OcxConfig).providers.fixture?.fastWire).toEqual({
        kind: "service-tier",
        canonicalToWire: { priority: "priority", flex: "flex" },
        foreignCallerTiers: "verbatim",
        betas: ["beta-one"],
      });
    }
  });

  test.each([
    { label: "closed kind", value: { kind: "future", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim" } },
    { label: "missing priority", value: { kind: "service-tier", canonicalToWire: { fast: "fast" }, foreignCallerTiers: "verbatim" } },
    { label: "blank priority", value: { kind: "service-tier", canonicalToWire: { priority: " " }, foreignCallerTiers: "verbatim" } },
    { label: "overlong wire value", value: { kind: "service-tier", canonicalToWire: { priority: "x".repeat(65) }, foreignCallerTiers: "verbatim" } },
    { label: "duplicate wire values", value: { kind: "service-tier", canonicalToWire: { priority: "fast", other: " fast " }, foreignCallerTiers: "verbatim" } },
    { label: "blank beta", value: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop", betas: [" "] } },
    { label: "duplicate betas", value: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop", betas: ["one", " one "] } },
    { label: "too many betas", value: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop", betas: Array.from({ length: 17 }, (_, index) => `b${index}`) } },
    { label: "unknown declaration key", value: { kind: "service-tier", canonicalToWire: { priority: "priority" }, foreignCallerTiers: "verbatim", future: true } },
  ])("rejects $label", ({ value }) => {
    expect(validateConfigCandidate(configWithFastWire(value)).ok).toBe(false);
  });

  test.each([
    { label: "provider capability", capability: { provider: true } },
    { label: "exact-model capability", capability: { exact: true } },
  ])("rejects null against $label", ({ capability }) => {
    expect(validateConfigCandidate(configWithFastWire(null, capability)).ok).toBe(false);
  });

  test("rejects null against an inherited registry capability", () => {
    expect(validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai-apikey",
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          fastWire: null,
        },
      },
    }).ok).toBe(false);
  });

  test("registry validation rejects the same null/capability conflict", () => {
    expect(providerRegistryFastWireError({ fastWire: null, supportsServiceTier: true }))
      .toContain("conflicts");
    expect(providerRegistryFastWireError({ fastWire: null, modelSupportsServiceTier: { [MODEL]: true } }))
      .toContain("conflicts");
  });

  test("A1 adds no explicit registry FastWire declaration", () => {
    expect(PROVIDER_REGISTRY.every(entry => entry.fastWire === undefined)).toBeTrue();
  });
});

describe("Responses TierDecision immutability", () => {
  test.each([
    { label: "set", decision: { kind: "set", value: "priority" } as TierDecision, expected: "priority" },
    { label: "drop", decision: { kind: "drop" } as TierDecision, expected: undefined },
  ])("$label uses a shallow outbound copy", ({ decision, expected }) => {
    const rawBody = { model: MODEL, input: "ping", service_tier: "flex" };
    const original = { ...rawBody };
    const parsed: OcxParsedRequest = {
      modelId: MODEL,
      context: { messages: [] },
      stream: true,
      options: { serviceTier: expected, tierDecision: decision },
      _rawBody: rawBody,
    };
    const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://fixture.example/v1",
      authMode: "key",
      apiKey: "sk-test",
    }));
    const outbound = JSON.parse(adapter.buildRequest(parsed).body) as Record<string, unknown>;

    expect(parsed._rawBody).toBe(rawBody);
    expect(rawBody).toEqual(original);
    if (expected === undefined) expect(outbound).not.toHaveProperty("service_tier");
    else expect(outbound.service_tier).toBe(expected);
  });
});
