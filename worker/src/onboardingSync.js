/**
 * Onboarding sync: per route, sync General task's x_studio_permanent_files + x_studio_temporary_files
 * to target root folder "Onboarding". Then GC: remove from target if no longer in those fields.
 */

import { odooExecuteKw, requireId, buildMarker, parseSrcAttIdFromMarker } from './odoo.js';
import { ensureOnboardingFolder } from './folders.js';
import { upsertMoveDocumentForAttachment, deleteTargetDocAndAttachment } from './docs.js';

/** Extract attachment IDs from Odoo M2M field (list of ids or [id, name] tuples) */
function attachmentIdsFromField(value) {
  if (!value || !Array.isArray(value)) return [];
  const ids = [];
  for (const v of value) {
    const id = Array.isArray(v) ? (v[0] ? Number(v[0]) : 0) : Number(v);
    if (id && Number.isFinite(id)) ids.push(id);
  }
  return ids;
}

/**
 * Run Onboarding sync + GC for all routes (in parallel with cap).
 * @param {object} sourceCfg
 * @param {Map<string,object>} routing - source_project_id -> route (with generalTask)
 * @param {number} maxConcurrentTargets
 */
export async function runOnboardingSync(sourceCfg, routing, maxConcurrentTargets = 10) {
  const routeList = [...routing.entries()].filter(([, r]) => r && r.generalTaskId);
  if (!routeList.length) return { synced: 0, gcDeleted: 0 };

  const runOne = async ([spid, route]) => {
    const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
    const companyId = requireId(route.target_company_id, { where: 'onboarding route' });
    const generalTask = route.generalTask;
    const permIds = attachmentIdsFromField(generalTask.x_studio_permanent_files);
    const tempIds = attachmentIdsFromField(generalTask.x_studio_temporary_files);
    const allIds = [...new Set([...permIds, ...tempIds])];
    let onboardingFolderId;
    try {
      onboardingFolderId = await ensureOnboardingFolder(targetCfg, companyId);
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      const isAccessDenied = /Access Denied|AccessDenied/i.test(msg);
      const reason = isAccessDenied
        ? 'Access Denied (user has no permission on Documents app in target DB)'
        : /auth failed|result false/i.test(msg)
          ? 'auth failed (wrong API key or user in target)'
          : 'error';
      console.warn('[onboarding] Skipping target (' + reason + '):', route.target_base_url, route.target_db, route.target_login, '—', msg.slice(0, 120));
      return { synced: 0, deleted: 0 };
    }
    let synced = 0;
    for (const attId of allIds) {
      try {
        const marker = buildMarker(sourceCfg.db, attId);
        const attRows = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[attId], ['id', 'name', 'mimetype', 'datas']], {}) || [];
        const att = attRows[0];
        if (!att || !att.datas) continue;

        const createAtt = async () => {
          const id = await odooExecuteKw(
            targetCfg, 'ir.attachment', 'create',
            [[{ name: att.name, mimetype: att.mimetype || 'application/octet-stream', datas: att.datas, type: 'binary', description: marker }]], {}
          );
          return requireId(id, { where: 'onboarding created' });
        };

        let existingAttIds = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 1 }) || [];
        let targetAttachmentId = existingAttIds.length
          ? requireId(existingAttIds[0], { where: 'onboarding existing' })
          : await createAtt();

        try {
          await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, onboardingFolderId, att.name);
        } catch (upsertErr) {
          if (upsertErr && upsertErr.code === 'ATTACHMENT_DELETED') {
            console.warn('[onboarding] Attachment', targetAttachmentId, 'was deleted, recreating for source att', attId);
            targetAttachmentId = await createAtt();
            await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, onboardingFolderId, att.name);
          } else {
            throw upsertErr;
          }
        }
        synced++;
      } catch (e) {
        console.warn('Onboarding sync att failed', attId, e && e.message);
      }
    }
    const deleted = await onboardingGcForTarget(sourceCfg, targetCfg, companyId, allIds);
    return { synced, deleted };
  };

  const cap = maxConcurrentTargets;
  let totalSynced = 0;
  let totalDeleted = 0;
  for (let i = 0; i < routeList.length; i += cap) {
    const chunk = routeList.slice(i, i + cap);
    const results = await Promise.all(chunk.map((entry) => runOne(entry)));
    for (const r of results) {
      totalSynced += r.synced;
      totalDeleted += r.deleted;
    }
  }
  return { synced: totalSynced, gcDeleted: totalDeleted };
}

/**
 * GC Onboarding folder: delete target docs whose source attachment is no longer in the allowed list.
 */
async function onboardingGcForTarget(sourceCfg, targetCfg, companyId, allowedSourceAttIds) {
  const allowedSet = new Set(allowedSourceAttIds);
  const markerPrefix = `ODOO_SYNC|SRC_DB=${sourceCfg.db}|SRC_ATT=`;
  const onboardingFolderId = await ensureOnboardingFolder(targetCfg, companyId);

  const docIds = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'search',
    [[['folder_id', '=', onboardingFolderId]]],
    { context: { allowed_company_ids: [companyId], force_company: companyId }, limit: 500 }
  ) || [];
  if (!docIds.length) return 0;

  const docs = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'read',
    [docIds, ['id', 'attachment_id']],
    { context: { allowed_company_ids: [companyId], force_company: companyId } }
  ) || [];
  const attIdsToCheck = [...new Set(docs.map((d) => d.attachment_id && (Array.isArray(d.attachment_id) ? d.attachment_id[0] : d.attachment_id)).filter(Boolean))];
  if (!attIdsToCheck.length) return 0;

  const atts = await odooExecuteKw(
    targetCfg,
    'ir.attachment',
    'read',
    [attIdsToCheck, ['id', 'description']],
    {}
  ) || [];
  let deleted = 0;
  for (const att of atts) {
    const srcId = parseSrcAttIdFromMarker(att.description);
    if (!srcId) continue;
    if (allowedSet.has(srcId)) continue;
    await deleteTargetDocAndAttachment(targetCfg, companyId, att.id);
    deleted++;
  }
  return deleted;
}
