/**
 * Target Odoo Documents: find or create folders (Taxes and Statutories tree, Onboarding).
 * Ported from Apps Script findOrCreateFolder_, ensureTaxPathFolder_, ensureBucketTaxPathFolder_.
 */

import { odooExecuteKw, requireId } from './odoo.js';

/** Root folder for Tax PH and Gvt contribs (formerly "Taxes"). */
export const TAXES_AND_STATUTORIES_ROOT = 'Taxes and Statutories';

function kwWithCompany(companyId, extraKw = {}) {
  return Object.assign({ context: { allowed_company_ids: [companyId], force_company: companyId } }, extraKw);
}

export async function findOrCreateFolder(targetCfg, companyId, name, parentFolderIdOrFalse) {
  const parentId = parentFolderIdOrFalse === false ? false : requireId(parentFolderIdOrFalse, { where: 'findOrCreateFolder', name });
  const domain = [['name', '=', String(name)], ['type', '=', 'folder'], ['folder_id', '=', parentId]];
  const ids = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'search',
    [domain],
    kwWithCompany(companyId, { limit: 5, order: 'id asc' })
  );
  if (ids && ids.length) {
    // Deduplicate: if multiple folders with same name exist, merge children into the first and delete extras
    if (ids.length > 1) {
      const keepId = ids[0];
      const dupes = ids.slice(1);
      console.warn('[folders] Dedup: found', ids.length, 'folders named', name, 'in parent', parentId, '- merging into', keepId);
      for (const dupeId of dupes) {
        try {
          const children = await odooExecuteKw(targetCfg, 'documents.document', 'search', [[['folder_id', '=', dupeId]]], kwWithCompany(companyId, { limit: 500 })) || [];
          if (children.length) {
            await odooExecuteKw(targetCfg, 'documents.document', 'write', [children, { folder_id: keepId }], kwWithCompany(companyId));
          }
          await odooExecuteKw(targetCfg, 'documents.document', 'unlink', [[dupeId]], kwWithCompany(companyId));
        } catch (e) {
          console.warn('[folders] Dedup cleanup failed for', dupeId, ':', e?.message || e);
        }
      }
      return requireId(keepId, { where: 'folder deduped', name, parentId });
    }
    return requireId(ids[0], { where: 'folder existing', name, parentId });
  }
  const createdId = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'create',
    [[{ name: String(name), type: 'folder', folder_id: parentId, company_id: companyId, owner_id: false }]],
    kwWithCompany(companyId)
  );
  // Re-check after create to handle concurrent creates (race condition)
  const recheck = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'search',
    [domain],
    kwWithCompany(companyId, { limit: 5, order: 'id asc' })
  ) || [];
  if (recheck.length > 1) {
    const keepId = recheck[0];
    const dupes = recheck.filter((id) => id !== keepId);
    console.warn('[folders] Race dedup: keeping', keepId, 'removing', dupes);
    for (const dupeId of dupes) {
      try {
        const children = await odooExecuteKw(targetCfg, 'documents.document', 'search', [[['folder_id', '=', dupeId]]], kwWithCompany(companyId, { limit: 500 })) || [];
        if (children.length) {
          await odooExecuteKw(targetCfg, 'documents.document', 'write', [children, { folder_id: keepId }], kwWithCompany(companyId));
        }
        await odooExecuteKw(targetCfg, 'documents.document', 'unlink', [[dupeId]], kwWithCompany(companyId));
      } catch (e) {
        console.warn('[folders] Race dedup cleanup failed for', dupeId, ':', e?.message || e);
      }
    }
    return requireId(keepId, { where: 'folder race-deduped', name, parentId });
  }
  return requireId(createdId, { where: 'folder created', name, parentId });
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
