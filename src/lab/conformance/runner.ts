import { discoverScenarios, loadCaseAuthority } from "./manifest";
import { runScenario } from "./executor";
import { buildNegativeControls } from "./negative-controls";
import type { ScenarioRunResult } from "./types";
import { CL01_SUITES } from "./types";

export interface ConformanceRunSummary {
  total: number;
  passed: number;
  failed: number;
  results: ScenarioRunResult[];
}

export async function runConformanceSuite(
  suites: readonly string[] = CL01_SUITES,
): Promise<ConformanceRunSummary> {
  const authority = loadCaseAuthority();
  const scenarios = discoverScenarios(authority, suites);
  const results: ScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export async function runNegativeControls(): Promise<ConformanceRunSummary> {
  const authority = loadCaseAuthority();
  const scenarios = buildNegativeControls(discoverScenarios(authority));
  const results: ScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  const passed = results.filter((r) => !r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export function listScenarioIds(suites: readonly string[] = CL01_SUITES): string[] {
  const authority = loadCaseAuthority();
  return discoverScenarios(authority, suites).map((s) => s.id);
}
