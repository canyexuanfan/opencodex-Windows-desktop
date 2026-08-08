import { describe, expect, test } from "bun:test";

import type { OcxConfig } from "../src/types";
import type { RequestLogContext } from "../src/server/request-log";
import type { RouteDecisionTraceV1 } from "../src/routing/trace";
import {
  handleResponsesWithPolicyFallback,
  rankPolicyFallbackCandidates,
} from "../src/server/responses/policy-fallback";

function policyTrace(): RouteDecisionTraceV1 {
  return {
    version: 1,
    decisionId: "decision-1",
    createdAt: 1,
    requestedModel: "policy/daily",
    routeKind: "policy",
    profile: { id: "daily", revision: "rev-1" },
    requirements: [],
    candidates: [
      {
        provider: "provider-a",
        model: "model-a",
        eligible: true,
        exclusions: [],
        score: { total: 0.90, components: {} },
      },
      {
        provider: "provider-b",
        model: "model-b",
        eligible: true,
        exclusions: [],
        score: { total: 0.80, components: {} },
      },
      {
        provider: "provider-c",
        model: "model-c",
        eligible: true,
        exclusions: [],
        score: { total: 0.80, components: {} },
      },
      {
        provider: "provider-d",
        model: "model-d",
        eligible: false,
        exclusions: [{ code: "tools" }],
        score: { total: 1, components: {} },
      },
    ],
    selected: {
      candidateIndex: 0,
      provider: "provider-a",
      model: "model-a",
      reason: "highest-score",
    },
  };
}

function request(): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "policy/daily", input: "hello", stream: false }),
  });
}

describe("policy candidate fallback", () => {
  test("ranks only eligible untried candidates by score and stable original order", () => {
    const trace = policyTrace();
    const ranked = rankPolicyFallbackCandidates(
      trace,
      new Set(["provider-a\u0000model-a"]),
    );

    expect(ranked.map(candidate => `${candidate.provider}/${candidate.model}`)).toEqual([
      "provider-b/model-b",
      "provider-c/model-c",
    ]);
  });

  test("retries the next policy candidate after a retryable pre-stream failure", async () => {
    const trace = policyTrace();
    const logCtx = {
      requestedModel: "policy/daily",
      routeDecision: trace,
      attempts: [],
    } as unknown as RequestLogContext;
    const seenModels: string[] = [];

    const response = await handleResponsesWithPolicyFallback(
      request(),
      {} as OcxConfig,
      logCtx,
      {},
      {
        runCore: async (req, _config, childLog) => {
          const body = await req.json() as { model: string };
          seenModels.push(body.model);
          if (seenModels.length === 1) {
            childLog.requestedModel = "policy/daily";
            childLog.routeDecision = trace;
            return new Response(
              JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }),
              { status: 429, headers: { "content-type": "application/json" } },
            );
          }
          childLog.requestedModel = body.model;
          childLog.routeDecision = {
            ...trace,
            requestedModel: body.model,
            routeKind: "explicit-provider",
            profile: undefined,
          };
          return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
        },
      },
    );

    expect(response.status).toBe(200);
    expect(seenModels).toEqual(["policy/daily", "provider-b/model-b"]);
    expect(logCtx.requestedModel).toBe("policy/daily");
    expect(logCtx.routeDecision).toBe(trace);
  });

  test("does not switch candidates for terminal client/input failures", async () => {
    const trace = policyTrace();
    const logCtx = {
      requestedModel: "policy/daily",
      routeDecision: trace,
      attempts: [],
    } as unknown as RequestLogContext;
    let calls = 0;

    const response = await handleResponsesWithPolicyFallback(
      request(),
      {} as OcxConfig,
      logCtx,
      {},
      {
        runCore: async (_req, _config, childLog) => {
          calls += 1;
          childLog.requestedModel = "policy/daily";
          childLog.routeDecision = trace;
          return new Response(
            JSON.stringify({ error: { message: "invalid request", type: "invalid_request_error" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });
});
