/**
 * Load routing from source Odoo: projects with Tax PH in "Master" -> General task with sync fields.
 * No Google Sheets; routes come from project.task (General) Studio fields.
 */

import { odooExecuteKw, parseAcctDb, isFalsyOdooValue } from './odoo.js';

const ROUTING_STAGE_NAME = 'Master';
const GENERAL_TASK_NAME = 'General';

const GENERAL_TASK_FIELDS = [
  'id',
  'project_id',
  'x_studio_enabled',
  'x_studio_email',
  'x_studio_api_key',
  'x_studio_multi_company',
  'x_studio_multicompany', // alternate Studio field name (no underscore)
  'x_studio_company_id_if_multi_company',
  'x_studio_accounting_database',
  'x_studio_permanent_files',
  'x_studio_temporary_files',
];

/**
 * @param {object} sourceCfg - { baseUrl, db, login, password }
 * @returns {Promise<Map<string, object>>} map: source_project_id (string) -> route
 *   route: { target_base_url, target_db, target_login, target_password, target_company_id, generalTaskId }
 */
export async function loadRoutesFromOdoo(sourceCfg) {
  // 1) Projects that have at least one Tax PH task in stage "Master"
  const taxTasks = await odooExecuteKw(
    sourceCfg,
    'project.task',
    'search_read',
    [[['name', 'ilike', 'Tax PH'], ['stage_id.name', '=', ROUTING_STAGE_NAME]]],
    { limit: 500, order: 'id desc', fields: ['id', 'project_id'] }
  );
  const projectIds = [...new Set(
    (taxTasks || [])
      .map((t) => (Array.isArray(t.project_id) ? t.project_id[0] : t.project_id))
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
  )];
  console.log('[routes] Tax PH tasks in stage "Master":', (taxTasks || []).length, '→ projectIds:', projectIds.length, projectIds.slice(0, 10));
  if (!projectIds.length) {
    console.log('[routes] No projects with Tax PH in Master → 0 routes');
    return new Map();
  }

  // 2) General task per project with sync + accounting fields
  const generalTasks = await odooExecuteKw(
    sourceCfg,
    'project.task',
    'search_read',
    [[['project_id', 'in', projectIds], ['name', '=', GENERAL_TASK_NAME]]],
    { limit: projectIds.length * 2, fields: GENERAL_TASK_FIELDS }
  );
  console.log('[routes] General tasks found:', (generalTasks || []).length);
  if (!generalTasks || !generalTasks.length) {
    console.log('[routes] No General tasks for those projects → 0 routes');
    return new Map();
  }

  const routing = new Map();
  for (const t of generalTasks) {
    const pid = Array.isArray(t.project_id) ? t.project_id[0] : t.project_id;
    if (!pid) continue;

    const enabled = t.x_studio_enabled === true || String(t.x_studio_enabled || '').toLowerCase() === 'true';
    if (!enabled) {
      console.log('[routes] project', pid, '→ General task sync disabled (x_studio_enabled)', t.x_studio_enabled);
      continue;
    }

    const email = String(t.x_studio_email || '').trim();
    const apiKey = String(t.x_studio_api_key || '').trim();
    const rawAcct = t.x_studio_accounting_database;
    const { target_base_url, target_db } = parseAcctDb(rawAcct);
    if (isFalsyOdooValue(target_base_url) || !target_db) {
      console.log('[routes] project', pid, '→ no target URL/db (x_studio_accounting_database)', rawAcct ? '(set)' : '(empty)');
      continue;
    }
    if (!email || !apiKey) {
      console.log('[routes] project', pid, '→ missing email or api key');
      continue;
    }

    // Support both x_studio_multi_company and x_studio_multicompany; when false or missing → default to company 1
    const multiCompanyRaw = t.x_studio_multi_company ?? t.x_studio_multicompany;
    const multiCompany = multiCompanyRaw === true || String(multiCompanyRaw || '').toLowerCase() === 'true';
    const companyId = multiCompany ? (Number(t.x_studio_company_id_if_multi_company) || 1) : 1;

    routing.set(String(pid), {
      source_project_id: Number(pid),
      target_base_url,
      target_db,
      target_login: email,
      target_password: apiKey,
      target_company_id: companyId,
      generalTaskId: t.id,
      generalTask: t, // for Onboarding: permanent/temporary file ids
    });
  }
  console.log('[routes] Active routes:', routing.size, '(projectIds:', [...routing.keys()].join(', ') + ')');
  return routing;
}
