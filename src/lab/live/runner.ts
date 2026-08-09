import { discoverLiveScenarios, loadLiveCaseAuthority } from "./manifest";
import { runLiveScenario, type LiveExecutorOptions } from "./executor";
import type { LabRouteContext, LiveScenarioRunResult } from "./types";
import { CL03_LIVE_SUITES } from "../conformance/types";

export interface LiveRunSummary {
  total: number;
  passed: number;
  failed: number;
  results: LiveScenarioRunResult[];
}

export async function runLiveSuite(
  routeContext: LabRouteContext,
  suites: readonly string[] = CL03_LIVE_SUITES,
  opts: LiveExecutorOptions = {},
): Promise<LiveRunSummary> {
  const authority = loadLiveCaseAuthority();
  const scenarios = discoverLiveScenarios(authority, suites);
  if (scenarios.length === 0) throw new Error("harness_failure: no CL-03 live scenarios discovered");
  const results: LiveScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runLiveScenario(scenario, routeContext, opts));
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export function listLiveScenarioIds(suites: readonly string[] = CL03_LIVE_SUITES): string[] {
  const authority = loadLiveCaseAuthority();
  return discoverLiveScenarios(authority, suites).map((s) => s.id);
}
