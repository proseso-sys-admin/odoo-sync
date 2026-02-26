/**
 * Orchestrator: load routes, run Tax PH and Onboarding in parallel.
 * Each flow processes target DBs in parallel (with cap).
 * Optional opts.targetKey or opts.targetKeys limits sync to those targets only.
 */

import { getSourceConfig } from './config.js';
import { loadRoutesFromOdoo } from './routes.js';
import { runTaxSync, syncSingleAttachment, deleteSingleAttachment, syncTaskAttachments } from './taxSync.js';
import { runOnboardingSync } from './onboardingSync.js';
import { MAX_CONCURRENT_TARGETS } from './config.js';
import { routeKey } from './odoo.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.targetKey] - If set, run sync only for this target (key = baseUrl|db|login|companyId).
 * @param {string[]} [opts.targetKeys] - If set, run sync only for these targets. Ignored if targetKey is set.
 * @returns {Promise<object>}
 */
export async function runFullSync(opts = {}) {
  const sourceCfg = getSourceConfig();
  let routing = await loadRoutesFromOdoo(sourceCfg);

  if (opts.targetKey || (opts.targetKeys && opts.targetKeys.length > 0)) {
    const allowed = opts.targetKey
      ? new Set([opts.targetKey])
      : new Set(opts.targetKeys);
    const filtered = new Map();
    for (const [spid, route] of routing) {
      if (allowed.has(routeKey(route))) filtered.set(spid, route);
    }
    routing = filtered;
  }

  if (!routing.size) {
    const targetFilter = opts.targetKey || opts.targetKeys ? 'no_matching_route' : undefined;
    return { ok: true, routes: 0, tax: null, onboarding: null, target_filter: targetFilter };
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

/**
 * Sync a single attachment immediately (bypass cursor).
 * @param {number|string} attachmentId - Source attachment ID
 * @returns {Promise<object>}
 */
export async function runSingleAttachmentSync(attachmentId) {
  const sourceCfg = getSourceConfig();
  const routing = await loadRoutesFromOdoo(sourceCfg);
  if (!routing.size) return { ok: false, error: 'no_routes' };
  return syncSingleAttachment(sourceCfg, routing, attachmentId);
}

/**
 * Delete a single synced attachment from all targets (bypass cursor).
 * @param {number|string} attachmentId - Source attachment ID that was deleted
 * @returns {Promise<object>}
 */
export async function runDeleteAttachmentSync(attachmentId) {
  const sourceCfg = getSourceConfig();
  const routing = await loadRoutesFromOdoo(sourceCfg);
  if (!routing.size) return { ok: false, error: 'no_routes' };
  return deleteSingleAttachment(sourceCfg, routing, attachmentId);
}

/**
 * Sync all attachments for a task (triggered by project.task write webhook).
 * @param {number|string} taskId - Source task ID
 * @returns {Promise<object>}
 */
export async function runTaskAttachmentsSync(taskId) {
  const sourceCfg = getSourceConfig();
  const routing = await loadRoutesFromOdoo(sourceCfg);
  if (!routing.size) return { ok: false, error: 'no_routes' };
  return syncTaskAttachments(sourceCfg, routing, taskId);
}
