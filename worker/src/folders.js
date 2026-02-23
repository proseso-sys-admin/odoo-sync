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
  const ids = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'search',
    [[['name', '=', String(name)], ['type', '=', 'folder'], ['folder_id', '=', parentId]]],
    kwWithCompany(companyId, { limit: 1 })
  );
  if (ids && ids.length) return requireId(ids[0], { where: 'folder existing', name, parentId });
  // Odoo 19 Documents: no is_folder field on create; type: 'folder' is enough
  const createdId = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'create',
    [[{ name: String(name), type: 'folder', folder_id: parentId, company_id: companyId, owner_id: false }]],
    kwWithCompany(companyId)
  );
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
  return FIELD_TO_TAX_BUCKET[f] || null;
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
  return FIELD_TO_GVT_CONTRIB_BUCKET[f] || null;
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
