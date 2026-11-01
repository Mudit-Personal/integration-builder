import type { Manifest } from './manifest.ts';
import { startMock } from './mock.ts';
import { runScenarioOn, SCENARIOS, type Scenario, type ScenarioResult } from './scenario-table.ts';

export { runScenarioOn, sandboxPassed, SCENARIOS, type Scenario, type ScenarioResult } from './scenario-table.ts';

export const runScenario = (m: Manifest, s: Scenario) => runScenarioOn(startMock, m, s);

export const runSandbox = async (m: Manifest, onResult?: (r: ScenarioResult) => void) => {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    const r = await runScenario(m, s);
    results.push(r);
    onResult?.(r);
  }
  return results;
};
