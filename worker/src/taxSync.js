/**
 * Tax PH and Gvt contribs Filing sync: cursor-based fetch from source, route by project,
 * sync to target Taxes and Statutories folder + GC.
 * Ported from Apps Script syncProjectTaskAttachmentsToManyTargets + syncDeletionsForTarget_.
 */

import { odooExecuteKw, requireId, buildMarker, parseSrcAttIdFromMarker, isQualifyingTaxTaskName, isQualifyingGvtContribsTaskName, targetKey, parseTaxAndPeriodFromTaskName } from './odoo.js';
import { getLastAttachmentId, setLastAttachmentId, getGcCursor, setGcCursor } from './state.js';
import { getTaxBucketFromResField, getGvtContribBucketFromResField, ensureTaxPathFolder, ensureBucketTaxPathFolder, TAX_BUCKET_FIELDS, FIELD_TO_TAX_BUCKET, GVT_CONTRIB_BUCKET_FIELDS, FIELD_TO_GVT_CONTRIB_BUCKET } from './folders.js';
import { upsertMoveDocumentForAttachment, deleteTargetDocAndAttachment } from './docs.js';
import { ATTACHMENT_BATCH_LIMIT } from './config.js';

const ALLOWED_STAGE_NAME = 'APPROVED / DONE';

/**
 * Run Tax PH sync + GC. Uses sourceCfg and routing (Map). Updates cursor and GC cursors.
 * @param {object} sourceCfg
 * @param {Map<string,object>} routing - source_project_id -> route
 * @param {number} maxConcurrentTargets - cap for parallel target processing
 */
export async function runTaxSync(sourceCfg, routing, maxConcurrentTargets = 10) {
  const lastId = await getLastAttachmentId();
  const routingObj = Object.fromEntries(routing);
  const routeEntries = Object.entries(routingObj);
  if (!routeEntries.length) return { metrics: { nAttIds: 0 }, gc: { scanned: 0, deleted: 0 } };

  const allowedProjectsByTarget = new Map();
  for (const [spid, r] of routeEntries) {
    const k = [r.target_base_url, r.target_db, r.target_login, String(r.target_company_id)].join('|');
    if (!allowedProjectsByTarget.has(k)) allowedProjectsByTarget.set(k, []);
    allowedProjectsByTarget.get(k).push(Number(spid));
  }

  const attIds = await odooExecuteKw(
    sourceCfg,
    'ir.attachment',
    'search',
    [[['res_model', '=', 'project.task'], ['type', '=', 'binary'], ['id', '>', lastId]]],
    { limit: ATTACHMENT_BATCH_LIMIT, order: 'id asc' }
  ) || [];

  const metrics = { nAttIds: attIds.length, nAttRead: 0, nProcessed: 0, nCreatedOrMoved: 0, nSkipNoProject: 0, nSkipNoRoute: 0, nSkipStage: 0, nSkipNotTaxOrGvt: 0 };
  let maxSeenId = lastId;

  if (!attIds.length) {
    const gcResult = await runTaxGcForAllTargets(routingObj, allowedProjectsByTarget, sourceCfg);
    return { metrics, gc: gcResult };
  }

  const atts = await odooExecuteKw(
    sourceCfg,
    'ir.attachment',
    'read',
    [attIds, ['id', 'name', 'mimetype', 'res_id', 'res_field', 'create_date']],
    {}
  ) || [];
  metrics.nAttRead = atts.length;

  const taskIds = [...new Set(atts.map((a) => a.res_id).filter(Boolean))];
  const tasks = taskIds.length
    ? (await odooExecuteKw(sourceCfg, 'project.task', 'read', [taskIds, ['id', 'project_id', 'name', 'stage_id']], {})) || []
    : [];
  const allBucketFields = [...TAX_BUCKET_FIELDS, ...GVT_CONTRIB_BUCKET_FIELDS];
  const tasksWithBuckets = taskIds.length
    ? (await odooExecuteKw(sourceCfg, 'project.task', 'read', [taskIds, ['id', ...allBucketFields]], {})) || []
    : [];

  /** Extract attachment ID from Odoo M2M value (id or [id, name] tuple) */
  const m2mAttId = (v) => {
    if (v == null) return 0;
    const id = Array.isArray(v) ? (v[0] ? Number(v[0]) : 0) : Number(v);
    return id && Number.isFinite(id) ? id : 0;
  };
  const bucketBySourceAttId = new Map();
  const fieldToBucket = { ...FIELD_TO_TAX_BUCKET, ...FIELD_TO_GVT_CONTRIB_BUCKET };
  for (const t of tasksWithBuckets) {
    for (const fieldName of allBucketFields) {
      const bucketName = fieldToBucket[fieldName];
      if (!bucketName) continue;
      const raw = t[fieldName];
      if (!Array.isArray(raw) || !raw.length) continue;
      for (const v of raw) {
        const attId = m2mAttId(v);
        if (attId && !bucketBySourceAttId.has(attId)) bucketBySourceAttId.set(attId, bucketName);
      }
    }
  }

  const taskToProject = new Map();
  const taskToName = new Map();
  const taskToStageName = new Map();
  for (const t of tasks) {
    const pid = Array.isArray(t.project_id) ? t.project_id[0] : t.project_id;
    taskToProject.set(t.id, pid);
    taskToName.set(t.id, t.name || '');
    const st = t.stage_id;
    taskToStageName.set(t.id, Array.isArray(st) ? String(st[1] || '') : '');
  }

  const byTarget = new Map();
  const failures = [];

  for (const a of atts) {
    maxSeenId = Math.max(maxSeenId, Number(a.id) || 0);
    const pid = taskToProject.get(a.res_id);
    if (!pid) { metrics.nSkipNoProject++; continue; }
    const route = routingObj[String(pid)];
    if (!route) { metrics.nSkipNoRoute++; continue; }
    const taskName = taskToName.get(a.res_id) || '';
    const stageUp = String(taskToStageName.get(a.res_id) || '').trim().toUpperCase();
    if (stageUp !== ALLOWED_STAGE_NAME) { metrics.nSkipStage++; continue; }
    const hasTax = /Tax PH/i.test(taskName);
    const hasGvtContribs = /Gvt contribs Filing/i.test(taskName);
    const hasBracketPeriod = /\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]/.test(taskName);
    if (!((hasTax || hasGvtContribs) && hasBracketPeriod)) { metrics.nSkipNotTaxOrGvt++; continue; }

    const k = targetKey({ baseUrl: route.target_base_url, db: route.target_db, login: route.target_login }, route.target_company_id);
    if (!byTarget.has(k)) byTarget.set(k, []);
    const parsed = parseTaxAndPeriodFromTaskName(taskName);
    const bucket = bucketBySourceAttId.get(a.id) ||
      (hasTax ? getTaxBucketFromResField(a.res_field) : getGvtContribBucketFromResField(a.res_field));
    byTarget.get(k).push({ a, route, taskName, parsed, bucket });
  }

  const targetCfgList = [];
  const seen = new Set();
  for (const [, list] of byTarget) {
    if (!list.length) continue;
    const r = list[0].route;
    const k = targetKey({ baseUrl: r.target_base_url, db: r.target_db, login: r.target_login }, r.target_company_id);
    if (seen.has(k)) continue;
    seen.add(k);
    targetCfgList.push({ key: k, route: r, items: list });
  }

  const runOne = async ({ key, route, items }) => {
    const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
    const companyId = requireId(route.target_company_id, { where: 'route.target_company_id' });
    for (const { a, parsed, bucket } of items) {
      try {
        const marker = buildMarker(sourceCfg.db, a.id);
        let existingAttIds = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 1 }) || [];
        let targetAttachmentId;
        if (existingAttIds.length) {
          targetAttachmentId = requireId(existingAttIds[0], { where: 'existing target attachment' });
        } else {
          const srcBin = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[a.id], ['datas']], {}) || [];
          const datas = srcBin[0] && srcBin[0].datas ? srcBin[0].datas : null;
          if (!datas) { failures.push({ reason: 'Missing datas', attachment_id: a.id }); continue; }
          targetAttachmentId = await odooExecuteKw(
            targetCfg,
            'ir.attachment',
            'create',
            [[{ name: a.name, mimetype: a.mimetype || 'application/octet-stream', datas, type: 'binary', description: marker }]],
            {}
          );
          targetAttachmentId = requireId(targetAttachmentId, { where: 'created target attachment' });
        }
        const destFolderId = bucket
          ? await ensureBucketTaxPathFolder(targetCfg, companyId, bucket, parsed.year, parsed.monthName)
          : await ensureTaxPathFolder(targetCfg, companyId, parsed.year, parsed.monthName);
        await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, destFolderId, a.name);
        metrics.nProcessed++;
        metrics.nCreatedOrMoved++;
      } catch (e) {
        failures.push({ reason: 'sync failed', attachment_id: a.id, err: String(e && e.message ? e.message : e) });
      }
    }
    const allowed = allowedProjectsByTarget.get(key) || [];
    const res = await syncDeletionsForTarget(sourceCfg, targetCfg, companyId, allowed);
    return res;
  };

  const chunks = [];
  for (let i = 0; i < targetCfgList.length; i += maxConcurrentTargets) {
    chunks.push(targetCfgList.slice(i, i + maxConcurrentTargets));
  }
  let gcScanned = 0;
  let gcDeleted = 0;
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(runOne));
    for (const r of results) {
      gcScanned += r.scanned;
      gcDeleted += r.deleted;
    }
  }

  await setLastAttachmentId(maxSeenId);
  return { metrics, gc: { scanned: gcScanned, deleted: gcDeleted }, failures };
}

async function syncDeletionsForTarget(sourceCfg, targetCfg, companyId, allowedSourceProjectIds) {
  const key = targetKey(targetCfg, companyId);
  const lastTargetAttId = await getGcCursor(key);
  const markerPrefix = `ODOO_SYNC|SRC_DB=${sourceCfg.db}|SRC_ATT=`;

  let rows = await odooExecuteKw(
    targetCfg,
    'ir.attachment',
    'search_read',
    [[['id', '>', lastTargetAttId], ['description', 'ilike', markerPrefix]], ['id', 'description']],
    { limit: 200, order: 'id asc' }
  ) || [];

  if (!rows.length && lastTargetAttId > 0) {
    await setGcCursor(key, 0);
    rows = await odooExecuteKw(
      targetCfg,
      'ir.attachment',
      'search_read',
      [[['id', '>', 0], ['description', 'ilike', markerPrefix]], ['id', 'description']],
      { limit: 200, order: 'id asc' }
    ) || [];
  }
  if (!rows.length) return { scanned: 0, deleted: 0 };

  const targetAttIds = [];
  const srcAttIds = [];
  const srcByTargetAtt = new Map();
  let maxSeen = lastTargetAttId;
  for (const r of rows) {
    maxSeen = Math.max(maxSeen, Number(r.id) || 0);
    const srcId = parseSrcAttIdFromMarker(r.description);
    if (!srcId) continue;
    targetAttIds.push(r.id);
    srcAttIds.push(srcId);
    srcByTargetAtt.set(r.id, srcId);
  }

  const srcAttRows = await odooExecuteKw(
    sourceCfg,
    'ir.attachment',
    'search_read',
    [[['id', 'in', srcAttIds], ['res_model', '=', 'project.task'], ['type', '=', 'binary']], ['id', 'res_id']],
    { limit: srcAttIds.length }
  ) || [];
  const srcExists = new Map();
  for (const s of srcAttRows) srcExists.set(Number(s.id), Number(s.res_id));

  const taskIds = [...new Set([...srcExists.values()].filter(Boolean))];
  const tasks = taskIds.length
    ? (await odooExecuteKw(sourceCfg, 'project.task', 'read', [taskIds, ['id', 'project_id', 'name', 'stage_id']], {})) || []
    : [];
  const taskInfo = new Map();
  for (const t of tasks) {
    const pid = Array.isArray(t.project_id) ? t.project_id[0] : t.project_id;
    const st = t.stage_id;
    const stName = Array.isArray(st) ? String(st[1] || '') : '';
    taskInfo.set(Number(t.id), { projectId: Number(pid) || 0, name: String(t.name || ''), stageNameUp: String(stName || '').trim().toUpperCase() });
  }

  let deleted = 0;
  for (const targetAttId of targetAttIds) {
    const srcAttId = srcByTargetAtt.get(targetAttId);
    const taskId = srcExists.get(srcAttId);
    if (!taskId) {
      await deleteTargetDocAndAttachment(targetCfg, companyId, targetAttId);
      deleted++;
      continue;
    }
    const info = taskInfo.get(taskId);
    if (!info) {
      await deleteTargetDocAndAttachment(targetCfg, companyId, targetAttId);
      deleted++;
      continue;
    }
    if (allowedSourceProjectIds && allowedSourceProjectIds.length && !allowedSourceProjectIds.includes(info.projectId)) {
      await deleteTargetDocAndAttachment(targetCfg, companyId, targetAttId);
      deleted++;
      continue;
    }
    const stillQualifies = (isQualifyingTaxTaskName(info.name) || isQualifyingGvtContribsTaskName(info.name)) && info.stageNameUp === ALLOWED_STAGE_NAME;
    if (!stillQualifies) {
      await deleteTargetDocAndAttachment(targetCfg, companyId, targetAttId);
      deleted++;
    }
  }
  await setGcCursor(key, maxSeen);
  return { scanned: rows.length, deleted };
}

async function runTaxGcForAllTargets(routingObj, allowedProjectsByTarget, sourceCfg) {
  const targets = [];
  const seen = new Set();
  for (const [spid, route] of Object.entries(routingObj)) {
    const k = [route.target_base_url, route.target_db, route.target_login, String(route.target_company_id)].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
    const companyId = requireId(route.target_company_id, { where: 'route.target_company_id', source_project_id: spid });
    const allowed = allowedProjectsByTarget.get(k) || [];
    targets.push(syncDeletionsForTarget(sourceCfg, targetCfg, companyId, allowed));
  }
  const results = await Promise.all(targets);
  return { scanned: results.reduce((s, r) => s + r.scanned, 0), deleted: results.reduce((s, r) => s + r.deleted, 0) };
}
