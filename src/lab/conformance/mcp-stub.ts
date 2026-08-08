import type { CaseRecord, NormalizedObservation } from "./types";
import { emptyObservation, projectMcpCalls, setClientResponse } from "./observation";

export const MCP_ACTION_TOKENS = [
  "mcp_namespace_round_trip_v1",
  "mcp_schema_bounds_v1",
  "mcp_call_result_v1",
  "mcp_resource_round_trip_v1",
] as const;

export type McpActionToken = typeof MCP_ACTION_TOKENS[number];

export function mcpActionToken(caseRecord: CaseRecord): McpActionToken | null {
  const features = caseRecord.requirements.requiredHarnessFeatures;
  const tokens = features.filter((f) => MCP_ACTION_TOKENS.includes(f as McpActionToken));
  if (tokens.length !== 1) return null;
  return tokens[0] as McpActionToken;
}

export function executeMcpSyntheticAction(caseRecord: CaseRecord): NormalizedObservation {
  const token = mcpActionToken(caseRecord);
  if (!token) throw new Error(`invalid_manifest: missing or ambiguous MCP action token for ${caseRecord.id}`);
  const decoded = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
  switch (token) {
    case "mcp_namespace_round_trip_v1":
      return runNamespaceRoundTrip(decoded);
    case "mcp_schema_bounds_v1":
      return runSchemaBounds(decoded);
    case "mcp_call_result_v1":
      return runCallResult(decoded);
    case "mcp_resource_round_trip_v1":
      return runResourceRoundTrip(decoded);
    default:
      throw new Error(`invalid_manifest: unsupported MCP action ${token}`);
  }
}

function runNamespaceRoundTrip(decoded: Record<string, unknown>): NormalizedObservation {
  const namespace = String(decoded.namespace ?? "");
  const name = String(decoded.name ?? "");
  const wireName = `${namespace}__${name}`;
  const observation = emptyObservation();
  observation.upstream.requests.push({
    status: 0,
    headers: {},
    json: {
      model: "fixture-model",
      tools: [{
        name: wireName,
        description: decoded.description,
        inputSchema: decoded.inputSchema,
      }],
    },
    rawBytes: 0,
  });
  const toolCalls = [{
    id: "call_fixture",
    name: wireName,
    arguments: {},
    kind: "function" as const,
    ordinal: 0,
  }];
  setClientResponse(observation, {
    toolCalls,
    mcpCalls: projectMcpCalls(toolCalls),
    status: 200,
  });
  return observation;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function runSchemaBounds(decoded: Record<string, unknown>): NormalizedObservation {
  const limitBytes = Number(decoded.limitBytes ?? 0);
  const exactSchema = String(decoded.exactSchema ?? "");
  const overSchema = String(decoded.overSchema ?? "");
  const observation = emptyObservation();
  const exactBound = utf8ByteLength(exactSchema) === limitBytes && JSON.parse(exactSchema) !== undefined
    ? "pass"
    : "fail";
  const oneOverRejected = utf8ByteLength(overSchema) === limitBytes + 1
    && JSON.parse(overSchema) !== undefined
    ? "pass"
    : "fail";
  observation.verifiers = {
    exact_bound: exactBound,
    one_over_rejected: oneOverRejected,
    partial_commit: false,
  };
  return observation;
}

function runCallResult(decoded: Record<string, unknown>): NormalizedObservation {
  const namespace = String(decoded.namespace ?? "");
  const name = String(decoded.name ?? "");
  const argumentsValue = decoded.arguments ?? {};
  const result = decoded.result;
  const wireName = `${namespace}__${name}`;
  const observation = emptyObservation();
  const toolCalls = [{
    id: "call_fixture",
    name: wireName,
    arguments: argumentsValue,
    kind: "function" as const,
    ordinal: 0,
  }];
  setClientResponse(observation, {
    toolCalls,
    mcpCalls: projectMcpCalls(toolCalls),
    json: result,
    status: 200,
  });
  observation.verifiers = {
    stub_received: { namespace, name, arguments: argumentsValue },
  };
  return observation;
}

function runResourceRoundTrip(decoded: Record<string, unknown>): NormalizedObservation {
  const resources = decoded.resources;
  const read = decoded.read as { uri?: string; contents?: unknown[] } | undefined;
  const observation = emptyObservation();
  setClientResponse(observation, {
    json: {
      resources,
      contents: read?.contents,
    },
    status: 200,
  });
  return observation;
}

export function attachMcpVerifiers(observation: NormalizedObservation, caseRecord: CaseRecord): void {
  if (caseRecord.id === "mcp-core.protocol.namespace-mapping") {
    const toolCalls = observation.client.response.toolCalls;
    if (toolCalls.length === 1) {
      observation.client.response.mcpCalls = projectMcpCalls(toolCalls);
    }
  }
  if (caseRecord.id === "mcp-core.protocol.call-result") {
    const decoded = JSON.parse(caseRecord.fixture.bytesUtf8) as Record<string, unknown>;
    observation.verifiers.stub_received = {
      namespace: String(decoded.namespace ?? ""),
      name: String(decoded.name ?? ""),
      arguments: decoded.arguments ?? {},
    };
  }
}
