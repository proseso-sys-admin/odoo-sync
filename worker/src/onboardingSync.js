/**
 * Onboarding sync: per route, sync General task's x_studio_permanent_files + x_studio_temporary_files
 * to target root folder "Onboarding". Then GC: remove from target if no longer in those fields.
 */

import { odooExecuteKw, requireId, buildMarker, parseSrcAttIdFromMarker } from './odoo.js';
import { ensureOnboardingFolder, evictFolderById } from './folders.js';
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
          } else if (upsertErr && upsertErr.code === 'FOLDER_ARCHIVED') {
            console.warn('[onboarding] Folder', onboardingFolderId, 'is archived, evicting cache and re-resolving for source att', attId);
            evictFolderById(onboardingFolderId);
            onboardingFolderId = await ensureOnboardingFolder(targetCfg, companyId);
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

const ONBOARDING_RES_FIELDS = new Set(['x_studio_permanent_files', 'x_studio_temporary_files']);

/**
 * Sync a single onboarding attachment by source attachment ID (webhook: ir.attachment create).
 * Detects onboarding via res_field or by scanning General task M2M fields (with retries).
 * Returns { ok: false, error: 'not_onboarding' } if the attachment isn't an onboarding file.
 */
export async function syncSingleOnboardingAttachment(sourceCfg, routing, attachmentId) {
  const attId = Number(attachmentId);
  if (!attId || !Number.isFinite(attId)) return { ok: false, error: 'invalid_id' };

  const attMeta = (await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[attId], ['id', 'name', 'mimetype', 'res_id', 'res_field']], {}) || [])[0];
  if (!attMeta) return { ok: false, error: 'attachment_not_found', attachment_id: attId };

  let matchedRoute = null;
  let matchedSpid = null;

  if (ONBOARDING_RES_FIELDS.has(attMeta.res_field) && attMeta.res_id) {
    const tasks = await odooExecuteKw(sourceCfg, 'project.task', 'read', [[attMeta.res_id], ['id', 'project_id']], {}) || [];
    const pid = tasks[0] && (Array.isArray(tasks[0].project_id) ? tasks[0].project_id[0] : tasks[0].project_id);
    if (pid) {
      const route = routing.get(String(pid));
      if (route && route.generalTaskId) { matchedRoute = route; matchedSpid = String(pid); }
    }
  }

  if (!matchedRoute) {
    const RETRY_DELAYS = [2000, 3000, 4000];
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      for (const [spid, route] of routing) {
        if (!route.generalTaskId) continue;
        let gt;
        if (attempt === 0) {
          gt = route.generalTask;
        } else {
          const fresh = await odooExecuteKw(sourceCfg, 'project.task', 'read',
            [[route.generalTaskId], ['id', 'x_studio_permanent_files', 'x_studio_temporary_files']], {}) || [];
          gt = fresh[0];
        }
        if (!gt) continue;
        const allIds = new Set([...attachmentIdsFromField(gt.x_studio_permanent_files), ...attachmentIdsFromField(gt.x_studio_temporary_files)]);
        if (allIds.has(attId)) { matchedRoute = route; matchedSpid = spid; break; }
      }
      if (matchedRoute) break;
      if (attempt < RETRY_DELAYS.length) {
        console.log(`[onboarding-webhook] att ${attId} not in any General task yet, retry ${attempt + 1}/${RETRY_DELAYS.length} after ${RETRY_DELAYS[attempt]}ms...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  if (!matchedRoute) return { ok: false, error: 'not_onboarding', attachment_id: attId };
  return syncOnboardingAttToTarget(sourceCfg, attId, attMeta, matchedRoute, matchedSpid);
}

/**
 * Sync all onboarding attachments for a given task (webhook: project.task write).
 * Returns { ok: false, error: 'not_onboarding_task' } if the task isn't a General task with onboarding files.
 */
export async function syncTaskOnboardingAttachments(sourceCfg, routing, taskId) {
  const tid = Number(taskId);
  if (!tid || !Number.isFinite(tid)) return { ok: false, error: 'invalid_task_id' };

  let matchedRoute = null;
  let matchedSpid = null;
  for (const [spid, route] of routing) {
    if (route.generalTaskId === tid) { matchedRoute = route; matchedSpid = spid; break; }
  }
  if (!matchedRoute) return { ok: false, error: 'not_onboarding_task', task_id: tid };

  const fresh = (await odooExecuteKw(sourceCfg, 'project.task', 'read',
    [[tid], ['id', 'x_studio_permanent_files', 'x_studio_temporary_files']], {}) || [])[0];
  if (!fresh) return { ok: false, error: 'task_not_found', task_id: tid };

  const allIds = [...new Set([...attachmentIdsFromField(fresh.x_studio_permanent_files), ...attachmentIdsFromField(fresh.x_studio_temporary_files)])];
  if (!allIds.length) return { ok: true, task_id: tid, synced: 0, type: 'onboarding' };

  console.log('[onboarding-task] task', tid, 'project', matchedSpid, 'onboarding attachments:', allIds.length);
  let synced = 0;
  const results = [];
  for (const attId of allIds) {
    try {
      const attMeta = (await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[attId], ['id', 'name', 'mimetype', 'res_id', 'res_field']], {}) || [])[0];
      if (!attMeta) { results.push({ id: attId, status: 'skip_not_found' }); continue; }
      const r = await syncOnboardingAttToTarget(sourceCfg, attId, attMeta, matchedRoute, matchedSpid);
      synced += r.ok ? 1 : 0;
      results.push({ id: attId, name: attMeta.name, status: r.ok ? r.action : 'error', error: r.ok ? undefined : r.error });
    } catch (e) {
      results.push({ id: attId, status: 'error', error: String(e?.message || e) });
    }
  }
  console.log('[onboarding-task] DONE task', tid, 'synced', synced);
  return { ok: true, task_id: tid, synced, results, type: 'onboarding' };
}

async function syncOnboardingAttToTarget(sourceCfg, attId, attMeta, route, spid) {
  const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
  const companyId = requireId(route.target_company_id, { where: 'onboarding webhook' });

  let onboardingFolderId;
  try {
    onboardingFolderId = await ensureOnboardingFolder(targetCfg, companyId);
  } catch (e) {
    return { ok: false, error: 'target_access_error', message: e?.message || String(e) };
  }

  const attRows = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[attId], ['id', 'name', 'mimetype', 'datas']], {}) || [];
  const att = attRows[0];
  if (!att || !att.datas) return { ok: false, error: 'source_attachment_empty', attachment_id: attId };

  const marker = buildMarker(sourceCfg.db, attId);
  const createAtt = async () => {
    const id = await odooExecuteKw(
      targetCfg, 'ir.attachment', 'create',
      [[{ name: att.name, mimetype: att.mimetype || 'application/octet-stream', datas: att.datas, type: 'binary', description: marker }]], {}
    );
    return requireId(id, { where: 'onboarding webhook created' });
  };

  let existingAttIds = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 1 }) || [];
  let targetAttachmentId = existingAttIds.length
    ? requireId(existingAttIds[0], { where: 'onboarding webhook existing' })
    : await createAtt();

  try {
    await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, onboardingFolderId, att.name);
  } catch (upsertErr) {
    if (upsertErr && upsertErr.code === 'ATTACHMENT_DELETED') {
      console.warn('[onboarding-webhook] Attachment', targetAttachmentId, 'was deleted, recreating for source att', attId);
      targetAttachmentId = await createAtt();
      await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, onboardingFolderId, att.name);
    } else if (upsertErr && upsertErr.code === 'FOLDER_ARCHIVED') {
      console.warn('[onboarding-webhook] Folder', onboardingFolderId, 'is archived, evicting cache and re-resolving for source att', attId);
      evictFolderById(onboardingFolderId);
      onboardingFolderId = await ensureOnboardingFolder(targetCfg, companyId);
      await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, onboardingFolderId, att.name);
    } else {
      throw upsertErr;
    }
  }
  console.log('[onboarding-webhook] DONE att=', attId, 'target_att=', targetAttachmentId, 'project=', spid);
  return { ok: true, action: existingAttIds.length ? 'moved' : 'synced', attachment_id: attId, name: att.name, target: route.target_base_url, type: 'onboarding' };
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
