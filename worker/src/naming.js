/**
 * Canonical naming helpers for synced Tax PH documents on the target Odoo database.
 *
 * Target format: "{FormCode} - {Period} - {CleanedFilename}"
 *   e.g. "BIR 0619-E - January 2026 - TRRC"
 *        "BIR 2550Q - Q1 2026 - Filed Return"
 *        "SSS - January 2026 - R3 Report"    (no form code → bucket label fallback)
 *        "January 2026 - doc"                 (no bucket → omit prefix)
 *
 * Only taxSync.js uses these helpers. onboardingSync.js is intentionally unchanged.
 */

/**
 * Map from bucket label → fn(parsed) → form-code string | null.
 * Return null to fall back to the bucket label itself.
 * Buckets with no entry here always use the bucket label as prefix.
 *
 * @type {Record<string, (parsed: {year: string|null, monthName: string|null}) => string|null>}
 */
export const BUCKET_FORM_CODES = {
  'VAT': (parsed) =>
    /^Q[1-4]$/i.test(parsed.monthName) ? 'BIR 2550Q' : 'BIR 2550M',

  'Expanded Withholding Tax': (_parsed) => 'BIR 0619-E',

  'Withholding Tax on Compensation': (_parsed) => 'BIR 1601-C',

  'Income Tax': (parsed) => {
    if (parsed.monthName === null) return 'BIR 1702-RT';
    if (/^Q[1-4]$/i.test(parsed.monthName)) return 'BIR 1702Q';
    return null; // monthly income tax → fall back to bucket label
  },

  // SSS, PHIC, HDMF, SSS Loans, HDMF Loans, Others:
  // no entry → buildTaxDocName uses the bucket label as prefix
};

/**
 * Format a period object into a human-readable string.
 *
 * @param {{ year: string|null, monthName: string|null }} parsed
 * @returns {string}  e.g. "January 2026", "Q1 2026", "2026", or ""
 */
export function formatPeriod(parsed) {
  if (!parsed || !parsed.year) return '';
  if (!parsed.monthName) return String(parsed.year);
  return `${parsed.monthName} ${parsed.year}`;
}

/**
 * Strip the file extension, replace underscores/hyphens with spaces, and
 * collapse runs of whitespace.
 *
 * @param {string} filename  e.g. "BIR_0619E_TRRC_Jan2026.pdf"
 * @returns {string}         e.g. "BIR 0619E TRRC Jan2026"
 */
export function cleanFileSuffix(filename) {
  const noExt = String(filename || '').replace(/\.[^.]+$/, '');
  return noExt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the canonical document name for a synced Tax PH attachment.
 *
 * Resolution order:
 *  1. Look up bucket in BUCKET_FORM_CODES; call fn(parsed) to get form code.
 *  2. If fn returns null, or bucket has no entry → use bucket label as prefix.
 *  3. If no bucket at all → omit the prefix segment entirely.
 *
 * @param {string} attachmentName  original source filename
 * @param {string|null|undefined} bucket  resolved bucket label, or falsy if unknown
 * @param {{ year: string|null, monthName: string|null }} parsed
 * @returns {string}
 */
export function buildTaxDocName(attachmentName, bucket, parsed) {
  let prefix = null;
  if (bucket) {
    const formCodeFn = BUCKET_FORM_CODES[bucket];
    if (formCodeFn) {
      prefix = formCodeFn(parsed);
    }
    // Fall back to bucket label if no mapping exists or fn returned null/undefined
    if (prefix === null || prefix === undefined) {
      prefix = bucket;
    }
  }

  const period = formatPeriod(parsed);
  const suffix = cleanFileSuffix(attachmentName);

  const parts = [];
  if (prefix) parts.push(prefix);
  if (period) parts.push(period);
  if (suffix) parts.push(suffix);
  return parts.join(' - ');
}
