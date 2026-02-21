/**
 * Orchestrator: load routes, run Tax PH and Onboarding in parallel.
 * Each flow processes target DBs in parallel (with cap).
 */

import { getSourceConfig } from './config.js';
import { loadRoutesFromOdoo } from './routes.js';
import { runTaxSync } from './taxSync.js';
import { runOnboardingSync } from './onboardingSync.js';
import { MAX_CONCURRENT_TARGETS } from './config.js';

export async function runFullSync() {
  const sourceCfg = getSourceConfig();
  const routing = await loadRoutesFromOdoo(sourceCfg);
  if (!routing.size) {
    return { ok: true, routes: 0, tax: null, onboarding: null };
  }

  const maxConcurrent = MAX_CONCURRENT_TARGETS;

  const [taxResult, onboardingResult] = await Promise.all([
    runTaxSync(sourceCfg, routing, maxConcurrent),
    runOnboardingSync(sourceCfg, routing, maxConcurrent),
  ]);

  return {
    ok: true,
    routes: routing.size,
    tax: {
      metrics: taxResult.metrics,
      gc: taxResult.gc,
      failures: taxResult.failures || [],
    },
    onboarding: {
      synced: onboardingResult.synced,
      gcDeleted: onboardingResult.gcDeleted,
    },
  };
}
