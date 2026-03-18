/**
 * Tax PH and Gvt contribs Filing sync: cursor-based fetch from source, route by project,
 * sync to target Taxes and Statutories folder + GC.
 * Ported from Apps Script syncProjectTaskAttachmentsToManyTargets + syncDeletionsForTarget_.
 */

import { odooExecuteKw, requireId, buildMarker, parseSrcAttIdFromMarker, isQualifyingTaxTaskName, isQualifyingGvtContribsTaskName, targetKey, parseTaxAndPeriodFromTaskName } from './odoo.js';
import { getLastAttachmentId, setLastAttachmentId, getGcCursor, setGcCursor } from './state.js';
import { buildTaxDocName } from './naming.js';
import { getTaxBucketFromResField, getGvtContribBucketFromResField, ensureTaxPathFolder, ensureBucketTaxPathFolder, TAX_BUCKET_FIELDS, FIELD_TO_TAX_BUCKET, GVT_CONTRIB_BUCKET_FIELDS, FIELD_TO_GVT_CONTRIB_BUCKET } from './folders.js';
import { upsertMoveDocumentForAttachment, deleteTargetDocAndAttachment } from './docs.js';
import { ATTACHMENT_BATCH_LIMIT } from './config.js';

const ALLOWED_STAGE_NAME = 'APPROVED / DONE';
const DEBUG = process.env.ODOO_SYNC_DEBUG === '1' || process.env.ODOO_SYNC_DEBUG === 'true';
function debugTax(...args) {
  if (DEBUG) console.warn('[tax-debug]', ...args);
}

/**
 * Post an internal note on the source task after a successful sync.
 * Failures are swallowed so they never abort the sync.
 */
async function postSyncNote(sourceCfg, taskId, docName, targetBaseUrl, bucket, parsed) {
  try {
    const parts = ['Taxes and Statutories'];
    if (parsed.year) parts.push(String(parsed.year));
    if (bucket) parts.push(String(bucket));
    if (parsed.monthName) parts.push(String(parsed.monthName));
    const location = parts.join(' / ');
    const body = `<p>Synced to ${targetBaseUrl}</p><p>File: ${docName}<br/>Location: ${location}</p>`;
    await odooExecuteKw(
      sourceCfg,
      'project.task',
      'message_post',
      [[taskId]],
      { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note', body_is_html: true }
    );
  } catch (e) {
    console.warn('[tax] postSyncNote failed for task', taskId, ':', String(e?.message || e));
  }
}

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
    const gcResult = await runTaxGcForAllTargets(routingObj, allowedProjectsByTarget, sourceCfg, maxConcurrentTargets);
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

  /** Extract attachment ID from Odoo M2M value: id, [id, name], { id }, or (6, 0, [ids]) command */
  const m2mAttId = (v) => {
    if (v == null) return 0;
    if (typeof v === 'object' && v !== null && 'id' in v) return Number(v.id) || 0;
    if (Array.isArray(v) && v.length === 3 && v[0] === 6 && Array.isArray(v[2])) return 0; // command, not single id
    const id = Array.isArray(v) ? (v[0] != null ? Number(v[0]) : 0) : Number(v);
    return id && Number.isFinite(id) && id > 0 ? id : 0;
  };
  /** Collect attachment IDs from one M2M value (single id, [id,name], {id}, or (6,0,[ids])) */
  const m2mAttIds = (v) => {
    if (v == null) return [];
    if (Array.isArray(v) && v.length === 3 && v[0] === 6 && Array.isArray(v[2])) {
      return (v[2] || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
    }
    const one = m2mAttId(v);
    return one ? [one] : [];
  };

  /** Extract all attachment IDs from a raw M2M field value (any format Odoo returns) */
  const collectIdsFromRaw = (raw) => {
    if (raw == null) return [];
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.ids && Array.isArray(raw.ids)) return raw.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (raw.commands && Array.isArray(raw.commands)) {
        const out = [];
        for (const cmd of raw.commands) {
          if (Array.isArray(cmd) && cmd.length === 3 && cmd[0] === 6 && Array.isArray(cmd[2])) {
            for (const id of cmd[2]) out.push(Number(id));
          }
        }
        return out.filter((n) => Number.isFinite(n) && n > 0);
      }
    }
    if (!Array.isArray(raw) || !raw.length) return [];
    if (raw.length === 3 && raw[0] === 6 && Array.isArray(raw[2])) return (raw[2] || []).map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0);
    const out = [];
    for (const v of raw) {
      if (v != null && typeof v === 'object' && 'id' in v) {
        const n = Number(v.id);
        if (n && Number.isFinite(n) && n > 0) out.push(n);
      } else for (const id of m2mAttIds(v)) if (id && Number.isFinite(id) && id > 0) out.push(id);
    }
    return out;
  };

  const bucketBySourceAttId = new Map();
  const fieldToBucket = { ...FIELD_TO_TAX_BUCKET, ...FIELD_TO_GVT_CONTRIB_BUCKET };
  const taskIdToTaskWithBuckets = new Map((tasksWithBuckets || []).map((t) => [Number(t.id), t]));
  let loggedRawSample = false;
  for (const t of tasksWithBuckets) {
    for (const fieldName of allBucketFields) {
      const bucketName = fieldToBucket[fieldName];
      if (!bucketName) continue;
      const raw = t[fieldName];
      const ids = collectIdsFromRaw(raw);
      if (!loggedRawSample && raw != null && (ids.length > 0 || (Array.isArray(raw) && raw.length > 0))) {
        console.warn('[tax] M2M raw sample field=', fieldName, 'task=', t.id, 'rawType=', Array.isArray(raw) ? 'array' : typeof raw, 'rawLength=', Array.isArray(raw) ? raw.length : 0, 'parsedIds=', ids.length, 'firstRaw=', JSON.stringify(Array.isArray(raw) ? raw[0] : raw));
        loggedRawSample = true;
      }
      for (const k of ids) {
        if (k && Number.isFinite(k) && !bucketBySourceAttId.has(k)) bucketBySourceAttId.set(k, bucketName);
      }
    }
  }

  if (DEBUG) {
    debugTax('tasksWithBuckets count:', tasksWithBuckets.length, '| bucketBySourceAttId size:', bucketBySourceAttId.size);
    if (tasksWithBuckets.length) {
      const t0 = tasksWithBuckets[0];
      const sample = {};
      for (const fn of allBucketFields) {
        const raw = t0[fn];
        if (raw != null && Array.isArray(raw) && raw.length) sample[fn] = { length: raw.length, first: raw[0], type: typeof raw[0] };
      }
      debugTax('sample task id=', t0.id, 'bucket fields sample:', JSON.stringify(sample));
    }
    if (bucketBySourceAttId.size) {
      const entries = [...bucketBySourceAttId.entries()].slice(0, 5);
      debugTax('bucketBySourceAttId sample:', entries.map(([id, b]) => `${id}->${b}`).join(', '));
    }
  }
  if (tasksWithBuckets.length > 0 && bucketBySourceAttId.size === 0) {
    const t0 = tasksWithBuckets[0];
    const keys = Object.keys(t0);
    const bucketKeys = allBucketFields.filter((f) => keys.includes(f));
    console.warn('[tax] No attachment ids in bucket map. Task keys include bucket fields:', bucketKeys.length === allBucketFields.length, 'firstTaskKeys=', keys.slice(0, 15).join(','), 'firstTaskRawSample=', allBucketFields.map((f) => ({ f, has: f in t0, type: typeof t0[f], val: t0[f] == null ? null : (Array.isArray(t0[f]) ? 'array#' + t0[f].length : String(t0[f]).slice(0, 80)) })));
  }

  /** Resolve bucket from task's M2M bucket fields when not in map (e.g. res_field empty or wrong format) */
  const getBucketForAttachment = (attId, taskId, hasTax) => {
    const k = Number(attId);
    if (k && bucketBySourceAttId.has(k)) return bucketBySourceAttId.get(k);
    const task = taskIdToTaskWithBuckets.get(taskId);
    if (!task) return null;
    for (const fieldName of allBucketFields) {
      const bucketName = fieldToBucket[fieldName];
      if (!bucketName) continue;
      const ids = collectIdsFromRaw(task[fieldName]);
      if (ids.includes(k)) return bucketName;
    }
    return null;
  };

  const taskToProject = new Map();
  const taskToName = new Map();
  const taskToStageName = new Map();
  for (const t of tasks) {
    const tid = Number(t.id);
    const pid = Array.isArray(t.project_id) ? t.project_id[0] : t.project_id;
    taskToProject.set(tid, pid);
    taskToName.set(tid, t.name || '');
    const st = t.stage_id;
    taskToStageName.set(tid, Array.isArray(st) ? String(st[1] || '') : '');
  }

  const byTarget = new Map();
  const failures = [];

  for (const a of atts) {
    maxSeenId = Math.max(maxSeenId, Number(a.id) || 0);
    const taskId = Number(a.res_id);
    const pid = taskToProject.get(taskId);
    if (!pid) { metrics.nSkipNoProject++; continue; }
    const route = routingObj[String(pid)];
    if (!route) { metrics.nSkipNoRoute++; continue; }
    const taskName = taskToName.get(taskId) || '';
    const stageUp = String(taskToStageName.get(taskId) || '').trim().toUpperCase();
    if (stageUp !== ALLOWED_STAGE_NAME) { metrics.nSkipStage++; continue; }
    const hasTax = /Tax PH/i.test(taskName);
    const hasGvtContribs = /Gvt contribs Filing/i.test(taskName);
    const hasBracketPeriod = /\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]/.test(taskName);
    if (!((hasTax || hasGvtContribs) && hasBracketPeriod)) { metrics.nSkipNotTaxOrGvt++; continue; }

    const k = targetKey({ baseUrl: route.target_base_url, db: route.target_db, login: route.target_login }, route.target_company_id);
    if (!byTarget.has(k)) byTarget.set(k, []);
    const parsed = parseTaxAndPeriodFromTaskName(taskName);
    const fromMap = bucketBySourceAttId.get(Number(a.id));
    const fromResField = hasTax ? getTaxBucketFromResField(a.res_field) : getGvtContribBucketFromResField(a.res_field);
    let bucket = fromMap || fromResField;
    if (!bucket) bucket = getBucketForAttachment(a.id, taskId, hasTax);
    if (DEBUG) {
      const source = fromMap ? 'M2M_map' : fromResField ? 'res_field' : bucket ? 'fallback' : 'NONE';
      debugTax('att', a.id, 'res_id=', a.res_id, 'res_field=', JSON.stringify(a.res_field), 'bucket=', bucket || '(null)', 'source=', source);
    }
    byTarget.get(k).push({ a, route, taskName, parsed, bucket });
  }

  // Diagnostic: same-task attachments with different bucket = bug
  for (const [, list] of byTarget) {
    const byTask = new Map();
    for (const it of list) byTask.set(Number(it.a.res_id), (byTask.get(Number(it.a.res_id)) || []).concat(it));
    for (const [tid, items] of byTask) {
      if (items.length < 2) continue;
      const buckets = [...new Set(items.map((i) => i.bucket || '(null)'))];
      if (buckets.length > 1) {
        console.warn('[tax] SAME TASK multiple buckets task=', tid, 'attIds=', items.map((i) => i.a.id), 'buckets=', buckets, 'res_fields=', items.map((i) => i.a.res_field));
      }
    }
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
        if (DEBUG) debugTax('dest folder att=', a.id, 'bucket=', bucket || '(no bucket)', 'path=', bucket ? `${parsed.year}/${bucket}/${parsed.monthName}` : `${parsed.year}/${parsed.monthName}`);
        const docName = buildTaxDocName(a.name, bucket, parsed);
        await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, destFolderId, docName);
        if (!existingAttIds.length) {
          await postSyncNote(sourceCfg, Number(a.res_id), docName, route.target_base_url, bucket, parsed);
        }
        metrics.nProcessed++;
        metrics.nCreatedOrMoved++;
      } catch (e) {
        failures.push({ reason: 'sync failed', attachment_id: a.id, err: String(e && e.message ? e.message : e) });
      }
    }
    const allowed = allowedProjectsByTarget.get(key) || [];
    try {
      return await syncDeletionsForTarget(sourceCfg, targetCfg, companyId, allowed);
    } catch (gcErr) {
      console.warn('[tax] GC skipped for target', key, '(will retry next run):', String(gcErr?.message || gcErr));
      return { scanned: 0, deleted: 0 };
    }
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
  if (failures && failures.length) console.warn('[tax] failures:', JSON.stringify(failures.slice(0, 10)));
  console.log('[tax] sync done nAttIds=', metrics.nAttIds, 'nCreatedOrMoved=', metrics.nCreatedOrMoved, 'nSkipStage=', metrics.nSkipStage, 'nSkipNotTaxOrGvt=', metrics.nSkipNotTaxOrGvt, 'failures=', (failures || []).length, 'gc.deleted=', gcDeleted);
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

async function runTaxGcForAllTargets(routingObj, allowedProjectsByTarget, sourceCfg, maxConcurrent = 10) {
  const targetList = [];
  const seen = new Set();
  for (const [spid, route] of Object.entries(routingObj)) {
    const k = [route.target_base_url, route.target_db, route.target_login, String(route.target_company_id)].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
    const companyId = requireId(route.target_company_id, { where: 'route.target_company_id', source_project_id: spid });
    const allowed = allowedProjectsByTarget.get(k) || [];
    targetList.push({ targetCfg, companyId, allowed });
  }
  let scanned = 0;
  let deleted = 0;
  for (let i = 0; i < targetList.length; i += maxConcurrent) {
    const chunk = targetList.slice(i, i + maxConcurrent);
    const results = await Promise.all(chunk.map(({ targetCfg, companyId, allowed }) =>
      syncDeletionsForTarget(sourceCfg, targetCfg, companyId, allowed)
    ));
    for (const r of results) { scanned += r.scanned; deleted += r.deleted; }
  }
  return { scanned, deleted };
}

/**
 * Sync a single attachment by id — bypasses the cursor entirely.
 * Used by the webhook when attachment_id is provided so the specific file is synced immediately.
 */
export async function syncSingleAttachment(sourceCfg, routing, attachmentId) {
  const attId = Number(attachmentId);
  if (!attId || !Number.isFinite(attId)) return { ok: false, error: 'Invalid attachment_id' };

  const atts = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[attId], ['id', 'name', 'mimetype', 'res_id', 'res_field', 'create_date']], {}) || [];
  if (!atts.length) return { ok: false, error: 'Attachment not found in source', attachment_id: attId };
  const a = atts[0];
  if (!a.res_id) return { ok: false, error: 'Attachment has no res_id (not linked to a task)', attachment_id: attId };

  const tasks = await odooExecuteKw(sourceCfg, 'project.task', 'read', [[a.res_id], ['id', 'project_id', 'name', 'stage_id']], {}) || [];
  if (!tasks.length) return { ok: false, error: 'Task not found', attachment_id: attId, task_id: a.res_id };
  const task = tasks[0];

  const pid = Array.isArray(task.project_id) ? task.project_id[0] : task.project_id;
  const routingObj = Object.fromEntries(routing);
  const route = routingObj[String(pid)];
  if (!route) return { ok: false, error: 'No route for project', attachment_id: attId, project_id: pid };

  const taskName = task.name || '';
  const st = task.stage_id;
  const stageName = Array.isArray(st) ? String(st[1] || '') : '';
  const stageUp = stageName.trim().toUpperCase();
  if (stageUp !== ALLOWED_STAGE_NAME) return { ok: false, error: `Task stage "${stageName}" is not "${ALLOWED_STAGE_NAME}"`, attachment_id: attId };

  const hasTax = /Tax PH/i.test(taskName);
  const hasGvtContribs = /Gvt contribs Filing/i.test(taskName);
  const hasBracketPeriod = /\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]/.test(taskName);
  if (!((hasTax || hasGvtContribs) && hasBracketPeriod)) return { ok: false, error: 'Task name does not match Tax PH or Gvt contribs pattern', attachment_id: attId, taskName };

  const allBucketFields = [...TAX_BUCKET_FIELDS, ...GVT_CONTRIB_BUCKET_FIELDS];
  const fieldToBucket = { ...FIELD_TO_TAX_BUCKET, ...FIELD_TO_GVT_CONTRIB_BUCKET };
  const tasksWithBuckets = await odooExecuteKw(sourceCfg, 'project.task', 'read', [[a.res_id], ['id', ...allBucketFields]], {}) || [];

  const collectIdsFromRaw = (raw) => {
    if (raw == null) return [];
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.ids && Array.isArray(raw.ids)) return raw.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (raw.commands && Array.isArray(raw.commands)) {
        const out = [];
        for (const cmd of raw.commands) if (Array.isArray(cmd) && cmd.length === 3 && cmd[0] === 6 && Array.isArray(cmd[2])) for (const id of cmd[2]) out.push(Number(id));
        return out.filter((n) => Number.isFinite(n) && n > 0);
      }
    }
    if (!Array.isArray(raw) || !raw.length) return [];
    if (raw.length === 3 && raw[0] === 6 && Array.isArray(raw[2])) return (raw[2] || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const out = [];
    for (const v of raw) {
      if (v != null && typeof v === 'object' && 'id' in v) { const n = Number(v.id); if (n > 0) out.push(n); }
      else { const n = Array.isArray(v) ? Number(v[0]) : Number(v); if (n && Number.isFinite(n) && n > 0) out.push(n); }
    }
    return out;
  };

  console.log('[single-att] att res_field=', JSON.stringify(a.res_field), 'res_id=', a.res_id, 'name=', a.name);

  const findBucketInFields = (taskData) => {
    if (!taskData) return null;
    for (const fieldName of allBucketFields) {
      const bucketName = fieldToBucket[fieldName];
      if (!bucketName) continue;
      const ids = collectIdsFromRaw(taskData[fieldName]);
      if (ids.includes(attId)) return bucketName;
    }
    return null;
  };

  const RETRY_DELAYS = [3000, 4000, 5000];
  let bucket = null;
  let attempt = 0;

  // First attempt — read bucket fields immediately
  let taskBucketData = tasksWithBuckets.length ? tasksWithBuckets[0] : null;
  bucket = findBucketInFields(taskBucketData);

  // Retry with delay: Odoo creates the attachment before updating the M2M field on the task,
  // so the bucket link may not exist yet when the webhook fires.
  while (!bucket && attempt < RETRY_DELAYS.length) {
    const delay = RETRY_DELAYS[attempt];
    console.log(`[single-att] bucket not found yet, retry ${attempt + 1}/${RETRY_DELAYS.length} after ${delay}ms...`);
    await new Promise((r) => setTimeout(r, delay));
    const freshTask = await odooExecuteKw(sourceCfg, 'project.task', 'read', [[a.res_id], ['id', ...allBucketFields]], {}) || [];
    taskBucketData = freshTask.length ? freshTask[0] : null;
    bucket = findBucketInFields(taskBucketData);
    attempt++;
  }

  if (taskBucketData) {
    const fieldDump = {};
    for (const fieldName of allBucketFields) {
      const raw = taskBucketData[fieldName];
      const ids = collectIdsFromRaw(raw);
      fieldDump[fieldName] = { raw: raw === false ? 'false' : raw == null ? 'null' : Array.isArray(raw) ? `array[${raw.length}]` : typeof raw, ids };
    }
    console.log('[single-att] task bucket fields:', JSON.stringify(fieldDump));
  }

  if (!bucket) {
    const fromResField = hasTax ? getTaxBucketFromResField(a.res_field) : getGvtContribBucketFromResField(a.res_field);
    if (fromResField) bucket = fromResField;
    console.log('[single-att] res_field fallback:', fromResField || '(none)');
  }
  console.log('[single-att] resolved bucket=', bucket || '(null)', attempt > 0 ? `(after ${attempt} retries)` : '(first try)');

  const parsed = parseTaxAndPeriodFromTaskName(taskName);
  const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
  const companyId = requireId(route.target_company_id, { where: 'route.target_company_id' });

  const marker = buildMarker(sourceCfg.db, a.id);
  let existingAttIds = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 1 }) || [];
  let targetAttachmentId;
  const isExisting = existingAttIds.length > 0;

  const createTargetAtt = async () => {
    const srcBin = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[a.id], ['datas']], {}) || [];
    const datas = srcBin[0] && srcBin[0].datas ? srcBin[0].datas : null;
    if (!datas) return null;
    const id = await odooExecuteKw(targetCfg, 'ir.attachment', 'create', [[{ name: a.name, mimetype: a.mimetype || 'application/octet-stream', datas, type: 'binary', description: marker }]], {});
    return requireId(id, { where: 'created target attachment' });
  };

  if (isExisting) {
    targetAttachmentId = requireId(existingAttIds[0], { where: 'existing target attachment' });
  } else {
    targetAttachmentId = await createTargetAtt();
    if (!targetAttachmentId) return { ok: false, error: 'Missing datas from source attachment', attachment_id: attId };
  }

  const destFolderId = bucket
    ? await ensureBucketTaxPathFolder(targetCfg, companyId, bucket, parsed.year, parsed.monthName)
    : await ensureTaxPathFolder(targetCfg, companyId, parsed.year, parsed.monthName);
  const docName = buildTaxDocName(a.name, bucket, parsed);
  try {
    await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, destFolderId, docName);
  } catch (upsertErr) {
    if (upsertErr && upsertErr.code === 'ATTACHMENT_DELETED') {
      console.warn('[single-att] Attachment', targetAttachmentId, 'was deleted, recreating for source att', attId);
      targetAttachmentId = await createTargetAtt();
      if (!targetAttachmentId) return { ok: false, error: 'Missing datas on retry', attachment_id: attId };
      await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, destFolderId, docName);
    } else {
      throw upsertErr;
    }
  }
  if (!isExisting) {
    await postSyncNote(sourceCfg, Number(a.res_id), docName, route.target_base_url, bucket, parsed);
  }

  const destPath = bucket ? `${parsed.year}/${bucket}/${parsed.monthName}` : `${parsed.year}/${parsed.monthName}`;
  console.log('[single-att] DONE att=', attId, 'target_att=', targetAttachmentId, isExisting ? '(moved)' : '(created)', 'dest=', destPath);
  return { ok: true, action: isExisting ? 'moved' : 'synced', attachment_id: attId, name: a.name, bucket: bucket || null, path: destPath, target: route.target_base_url };
}

/**
 * Delete a single synced attachment from all targets — used when source attachment is unlinked.
 * Searches every unique target for the marker and removes the target attachment + document.
 */
export async function deleteSingleAttachment(sourceCfg, routing, attachmentId) {
  const attId = Number(attachmentId);
  if (!attId || !Number.isFinite(attId)) return { ok: false, error: 'Invalid attachment_id' };

  const marker = buildMarker(sourceCfg.db, attId);
  const seen = new Set();
  const results = [];

  for (const [, route] of routing) {
    const k = targetKey({ baseUrl: route.target_base_url, db: route.target_db, login: route.target_login }, route.target_company_id);
    if (seen.has(k)) continue;
    seen.add(k);
    const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
    const companyId = requireId(route.target_company_id, { where: 'route.target_company_id' });
    try {
      const targetAttIds = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 10 }) || [];
      for (const tAttId of targetAttIds) {
        await deleteTargetDocAndAttachment(targetCfg, companyId, tAttId);
        results.push({ target: route.target_base_url, deleted_target_att: tAttId });
      }
    } catch (e) {
      results.push({ target: route.target_base_url, error: String(e?.message || e) });
    }
  }

  return { ok: true, action: 'deleted', attachment_id: attId, targets: results };
}

/**
 * Sync all attachments for a single task — triggered by project.task write webhook.
 * Reads task bucket fields (M2M already updated), syncs each attachment to the correct bucket,
 * and removes target attachments that are no longer linked to any bucket field.
 */
export async function syncTaskAttachments(sourceCfg, routing, taskId) {
  const tid = Number(taskId);
  if (!tid || !Number.isFinite(tid)) return { ok: false, error: 'Invalid task_id' };

  const tasks = await odooExecuteKw(sourceCfg, 'project.task', 'read', [[tid], ['id', 'project_id', 'name', 'stage_id']], {}) || [];
  if (!tasks.length) return { ok: false, error: 'Task not found', task_id: tid };
  const task = tasks[0];

  const pid = Array.isArray(task.project_id) ? task.project_id[0] : task.project_id;
  const routingObj = Object.fromEntries(routing);
  const route = routingObj[String(pid)];
  if (!route) return { ok: false, error: 'No route for project', task_id: tid, project_id: pid };

  const taskName = task.name || '';
  const st = task.stage_id;
  const stageName = Array.isArray(st) ? String(st[1] || '') : '';
  const stageUp = stageName.trim().toUpperCase();
  if (stageUp !== ALLOWED_STAGE_NAME) return { ok: false, error: `Task stage "${stageName}" is not "${ALLOWED_STAGE_NAME}"`, task_id: tid };

  const hasTax = /Tax PH/i.test(taskName);
  const hasGvtContribs = /Gvt contribs Filing/i.test(taskName);
  const hasBracketPeriod = /\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]/.test(taskName);
  if (!((hasTax || hasGvtContribs) && hasBracketPeriod)) return { ok: false, error: 'Task name does not match Tax PH or Gvt contribs pattern', task_id: tid, taskName };

  const allBucketFields = hasTax ? TAX_BUCKET_FIELDS : GVT_CONTRIB_BUCKET_FIELDS;
  const fieldToBucket = hasTax ? FIELD_TO_TAX_BUCKET : FIELD_TO_GVT_CONTRIB_BUCKET;
  const taskData = (await odooExecuteKw(sourceCfg, 'project.task', 'read', [[tid], ['id', ...allBucketFields]], {}) || [])[0];
  if (!taskData) return { ok: false, error: 'Could not read task bucket fields', task_id: tid };

  const collectIdsFromRaw = (raw) => {
    if (raw == null) return [];
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.ids && Array.isArray(raw.ids)) return raw.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (raw.commands && Array.isArray(raw.commands)) {
        const out = [];
        for (const cmd of raw.commands) if (Array.isArray(cmd) && cmd.length === 3 && cmd[0] === 6 && Array.isArray(cmd[2])) for (const id of cmd[2]) out.push(Number(id));
        return out.filter((n) => Number.isFinite(n) && n > 0);
      }
    }
    if (!Array.isArray(raw) || !raw.length) return [];
    if (raw.length === 3 && raw[0] === 6 && Array.isArray(raw[2])) return (raw[2] || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const out = [];
    for (const v of raw) {
      if (v != null && typeof v === 'object' && 'id' in v) { const n = Number(v.id); if (n > 0) out.push(n); }
      else { const n = Array.isArray(v) ? Number(v[0]) : Number(v); if (n && Number.isFinite(n) && n > 0) out.push(n); }
    }
    return out;
  };

  // Build map: srcAttId -> bucketName for all attachments in all bucket fields
  const attToBucket = new Map();
  const allSourceAttIds = new Set();
  for (const fieldName of allBucketFields) {
    const bucketName = fieldToBucket[fieldName];
    if (!bucketName) continue;
    const ids = collectIdsFromRaw(taskData[fieldName]);
    for (const id of ids) {
      attToBucket.set(id, bucketName);
      allSourceAttIds.add(id);
    }
  }

  console.log('[task-sync] task=', tid, 'name=', taskName, 'attachments in buckets:', allSourceAttIds.size, 'buckets:', [...new Set(attToBucket.values())].join(', '));

  // Read source attachment metadata
  const srcAtts = allSourceAttIds.size
    ? await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[...allSourceAttIds], ['id', 'name', 'mimetype']], {}) || []
    : [];
  const srcAttMap = new Map(srcAtts.map((a) => [Number(a.id), a]));

  const parsed = parseTaxAndPeriodFromTaskName(taskName);
  const targetCfg = { baseUrl: route.target_base_url, db: route.target_db, login: route.target_login, password: route.target_password };
  const companyId = requireId(route.target_company_id, { where: 'route.target_company_id' });

  let synced = 0;
  let deleted = 0;
  const results = [];

  // Sync all attachments in parallel — folder cache + lock prevents duplicate folder creation
  const syncJobs = [...attToBucket.entries()].map(async ([srcAttId, bucket]) => {
    const a = srcAttMap.get(srcAttId);
    if (!a) { results.push({ id: srcAttId, status: 'skip_not_found' }); return; }
    try {
      const marker = buildMarker(sourceCfg.db, srcAttId);
      const existingAttIds = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 1 }) || [];
      let targetAttachmentId;
      const isExisting = existingAttIds.length > 0;

      const createTargetAtt = async () => {
        // Retry reading datas: Odoo may not have committed the binary yet when the task-write
        // webhook fires (especially for freshly uploaded attachments).
        const DATAS_RETRY_DELAYS = [2000, 3000];
        let datas = null;
        for (let attempt = 0; attempt <= DATAS_RETRY_DELAYS.length; attempt++) {
          if (attempt > 0) {
            const delay = DATAS_RETRY_DELAYS[attempt - 1];
            console.log(`[task-sync] datas not ready for src att ${srcAttId}, retry ${attempt}/${DATAS_RETRY_DELAYS.length} after ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
          }
          const srcBin = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [[srcAttId], ['datas']], {}) || [];
          datas = srcBin[0]?.datas;
          if (datas) break;
        }
        if (!datas) return null;
        const id = await odooExecuteKw(targetCfg, 'ir.attachment', 'create', [[{ name: a.name, mimetype: a.mimetype || 'application/octet-stream', datas, type: 'binary', description: marker }]], {});
        return requireId(id, { where: 'created target attachment' });
      };

      if (isExisting) {
        targetAttachmentId = requireId(existingAttIds[0], { where: 'existing target attachment' });
      } else {
        targetAttachmentId = await createTargetAtt();
        if (!targetAttachmentId) { results.push({ id: srcAttId, status: 'skip_no_data' }); return; }
      }
      const destFolderId = await ensureBucketTaxPathFolder(targetCfg, companyId, bucket, parsed.year, parsed.monthName);
      const docName = buildTaxDocName(a.name, bucket, parsed);
      try {
        await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, destFolderId, docName);
      } catch (upsertErr) {
        if (upsertErr && upsertErr.code === 'ATTACHMENT_DELETED') {
          console.warn('[batch-tax] Attachment', targetAttachmentId, 'was deleted, recreating for source att', srcAttId);
          targetAttachmentId = await createTargetAtt();
          if (!targetAttachmentId) { results.push({ id: srcAttId, status: 'skip_no_data_retry' }); return; }
          await upsertMoveDocumentForAttachment(targetCfg, companyId, targetAttachmentId, destFolderId, docName);
        } else {
          throw upsertErr;
        }
      }
      if (!isExisting) {
        await postSyncNote(sourceCfg, tid, docName, route.target_base_url, bucket, parsed);
      }
      synced++;
      results.push({ id: srcAttId, name: a.name, bucket, status: isExisting ? 'moved' : 'created' });
    } catch (e) {
      results.push({ id: srcAttId, status: 'error', error: String(e?.message || e) });
    }
  });
  await Promise.all(syncJobs);

  // GC: find all synced target attachments for this task, delete any whose source is not in a bucket field
  const markerPrefix = `ODOO_SYNC|SRC_DB=${sourceCfg.db}|SRC_ATT=`;
  const allTaskAttIds = await odooExecuteKw(sourceCfg, 'ir.attachment', 'search', [
    [['res_model', '=', 'project.task'], ['res_id', '=', tid], ['type', '=', 'binary']],
  ], { limit: 500 }) || [];
  const allTaskAttSet = new Set(allTaskAttIds.map(Number));

  // Build markers for all task attachments NOT in bucket fields → search target in one batch
  const orphanedSrcIds = [...allTaskAttSet].filter((id) => id && !allSourceAttIds.has(id));
  const deleteJobs = orphanedSrcIds.map(async (srcId) => {
    const marker = buildMarker(sourceCfg.db, srcId);
    const targetAtts = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['description', '=', marker]]], { limit: 5 }) || [];
    for (const tAttId of targetAtts) {
      try {
        await deleteTargetDocAndAttachment(targetCfg, companyId, tAttId);
        deleted++;
        results.push({ id: srcId, status: 'deleted', target_att: tAttId });
      } catch (e) {
        results.push({ id: srcId, status: 'delete_error', error: String(e?.message || e) });
      }
    }
  });
  await Promise.all(deleteJobs);
  if (deleted) console.log('[task-sync] deleted', deleted, 'orphaned attachments');

  const nonSuccess = results.filter((r) => r.status !== 'moved' && r.status !== 'created');
  if (nonSuccess.length) console.warn('[task-sync] task=', tid, 'non-success results:', JSON.stringify(nonSuccess));
  console.log('[task-sync] DONE task=', tid, 'synced=', synced, 'deleted=', deleted);
  return { ok: true, task_id: tid, taskName, synced, deleted, results };
}
