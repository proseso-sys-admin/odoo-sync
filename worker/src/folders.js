/**
 * Target Odoo Documents: find or create folders (Taxes and Statutories tree, Onboarding).
 * Uses in-memory cache + per-folder lock to prevent duplicate creation from concurrent requests.
 */

import { odooExecuteKw, requireId } from './odoo.js';

/** Root folder for Tax PH and Gvt contribs (formerly "Taxes"). */
export const TAXES_AND_STATUTORIES_ROOT = 'Taxes and Statutories';

function kwWithCompany(companyId, extraKw = {}) {
  return Object.assign({ context: { allowed_company_ids: [companyId], force_company: companyId } }, extraKw);
}

// In-memory cache: "baseUrl|db|companyId|parentId|name" -> folderId
const _folderCache = new Map();
// Per-folder lock: same key -> Promise (resolves when the creating request finishes)
const _folderLocks = new Map();

function _cacheKey(targetCfg, companyId, name, parentId) {
  return `${targetCfg.baseUrl}|${targetCfg.db}|${companyId}|${parentId}|${name}`;
}

export async function findOrCreateFolder(targetCfg, companyId, name, parentFolderIdOrFalse) {
  const parentId = parentFolderIdOrFalse === false ? false : requireId(parentFolderIdOrFalse, { where: 'findOrCreateFolder', name });
  const ck = _cacheKey(targetCfg, companyId, name, parentId);

  // Fast path: cached
  if (_folderCache.has(ck)) return _folderCache.get(ck);

  // If another request is already creating this exact folder, wait for it
  if (_folderLocks.has(ck)) {
    await _folderLocks.get(ck);
    if (_folderCache.has(ck)) return _folderCache.get(ck);
  }

  // Acquire lock
  let unlock;
  const lock = new Promise((r) => { unlock = r; });
  _folderLocks.set(ck, lock);

  try {
    const ids = await odooExecuteKw(
      targetCfg,
      'documents.document',
      'search',
      [[['name', '=', String(name)], ['type', '=', 'folder'], ['folder_id', '=', parentId]]],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (ids && ids.length) {
      const id = requireId(ids[0], { where: 'folder existing', name, parentId });
      _folderCache.set(ck, id);
      return id;
    }
    const createdId = await odooExecuteKw(
      targetCfg,
      'documents.document',
      'create',
      [[{ name: String(name), type: 'folder', folder_id: parentId, company_id: companyId, owner_id: false }]],
      kwWithCompany(companyId)
    );
    const id = requireId(createdId, { where: 'folder created', name, parentId });
    _folderCache.set(ck, id);
    return id;
  } finally {
    unlock();
    _folderLocks.delete(ck);
  }
}

/** Taxes and Statutories / [Year] / [Month] (no bucket) */
export async function ensureTaxPathFolder(targetCfg, companyId, yearOrNull, monthNameOrNull) {
  const root = await findOrCreateFolder(targetCfg, companyId, TAXES_AND_STATUTORIES_ROOT, false);
  if (!yearOrNull) return root;
  const yearFolder = await findOrCreateFolder(targetCfg, companyId, String(yearOrNull), root);
  if (monthNameOrNull) return findOrCreateFolder(targetCfg, companyId, String(monthNameOrNull), yearFolder);
  return yearFolder;
}

/** Taxes and Statutories / [Year] / <Bucket> / [Month] */
export const FIELD_TO_TAX_BUCKET = {
  x_studio_tax_ph_documents: 'VAT',
  x_studio_many2many_field_7t8_1jbplpmld: 'Expanded Withholding Tax',
  x_studio_wtc: 'Withholding Tax on Compensation',
  x_studio_itr: 'Income Tax',
  x_studio_other_tax_documents: 'Others',
};

export function getTaxBucketFromResField(resField) {
  const f = String(resField || '').trim();
  if (FIELD_TO_TAX_BUCKET[f]) return FIELD_TO_TAX_BUCKET[f];
  const lower = f.toLowerCase();
  const key = Object.keys(FIELD_TO_TAX_BUCKET).find((k) => k.toLowerCase() === lower);
  return key ? FIELD_TO_TAX_BUCKET[key] : null;
}

export const TAX_BUCKET_FIELDS = Object.keys(FIELD_TO_TAX_BUCKET);

/** Gvt contribs Filing: field → folder name under Taxes and Statutories. */
export const FIELD_TO_GVT_CONTRIB_BUCKET = {
  x_studio_sss_contributions: 'SSS',
  x_studio_philhealth_contributions: 'PHIC',
  x_studio_pag_ibig_contributions: 'HDMF',
  x_studio_sss_loans: 'SSS Loans',
  x_studio_pag_ibig_loans: 'HDMF Loans',
};

export const GVT_CONTRIB_BUCKET_FIELDS = Object.keys(FIELD_TO_GVT_CONTRIB_BUCKET);

export function getGvtContribBucketFromResField(resField) {
  const f = String(resField || '').trim();
  if (FIELD_TO_GVT_CONTRIB_BUCKET[f]) return FIELD_TO_GVT_CONTRIB_BUCKET[f];
  const lower = f.toLowerCase();
  const key = Object.keys(FIELD_TO_GVT_CONTRIB_BUCKET).find((k) => k.toLowerCase() === lower);
  return key ? FIELD_TO_GVT_CONTRIB_BUCKET[key] : null;
}

export async function ensureBucketTaxPathFolder(targetCfg, companyId, bucketName, yearOrNull, monthNameOrNull) {
  const root = await findOrCreateFolder(targetCfg, companyId, TAXES_AND_STATUTORIES_ROOT, false);
  if (!yearOrNull) return findOrCreateFolder(targetCfg, companyId, String(bucketName), root);
  const yearFolder = await findOrCreateFolder(targetCfg, companyId, String(yearOrNull), root);
  const bucketFolder = await findOrCreateFolder(targetCfg, companyId, String(bucketName), yearFolder);
  if (monthNameOrNull) return findOrCreateFolder(targetCfg, companyId, String(monthNameOrNull), bucketFolder);
  return bucketFolder;
}

/** Root-level Onboarding folder (same level as Taxes). */
export async function ensureOnboardingFolder(targetCfg, companyId) {
  return findOrCreateFolder(targetCfg, companyId, 'Onboarding', false);
}

/** Remove any cache entry that resolves to the given folder ID (call after an archived-folder error). */
export function evictFolderById(folderId) {
  for (const [key, val] of _folderCache) {
    if (val === folderId) _folderCache.delete(key);
  }
}
