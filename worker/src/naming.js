/**
 * Canonical naming helpers for synced Tax PH documents on the target Odoo database.
 *
 * Target format: "{FormCode} - {Period} - {CleanedFilename}"
 *   e.g. "BIR 0619-E - January 2026 - TRRC"
 *        "BIR 2550Q - Q1 2026 - Filed Return"
 *        "SSS - January 2026 - R3 Report"    (no form code → bucket label fallback)
 *        "January 2026 - doc"                 (no bucket → omit prefix)
 *        "BIR 2550M - January 2026"           (suffix fully redundant → omitted)
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
 * Strip the file extension, replace underscores/hyphens with spaces, split on
 * letter↔digit boundaries so fused tokens like "Jan2026" and "BIR2550M" become
 * separate words, then collapse whitespace.
 *
 * @param {string} filename  e.g. "BIR_0619E_TRRC_Jan2026.pdf"
 * @returns {string}         e.g. "BIR 0619E TRRC Jan 2026"
 */
export function cleanFileSuffix(filename) {
  const noExt = String(filename || '').replace(/\.[^.]+$/, '');
  return noExt
    .replace(/[_-]+/g, ' ')
    // Split alpha→digit boundary when alpha part is 2+ chars (e.g. "Jan2026" → "Jan 2026")
    .replace(/([a-zA-Z]{2,})(\d)/g, '$1 $2')
    // Split digit→alpha boundary when alpha part is 2+ chars (e.g. "R3Report" → "R3 Report")
    .replace(/(\d)([a-zA-Z]{2,})/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Full and 3-char abbreviated month names (lower-cased). */
const MONTH_WORDS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

/**
 * Remove words from suffix that duplicate information already present in the
 * prefix (form code) and period segments.
 *
 * Rules:
 *  - Year (20XX), month name/abbrev, and quarter label (Q1-Q4) are always stripped
 *    when a period is present (they appear in the period segment).
 *  - Prefix word tokens are stripped (e.g. "BIR", "2550M" → also "2550", "M").
 *  - For BIR-type prefixes, any 4-digit form number (optionally followed by 1-2
 *    letters) is stripped, catching variants like "0619E", "2550Q" in the filename.
 *  - Returns empty string when all words are redundant (suffix omitted from name).
 *
 * @param {string} suffix   already-cleaned filename body
 * @param {string|null} prefix  e.g. "BIR 2550M" or "SSS" or null
 * @param {string} period   e.g. "January 2026" or "Q1 2026"
 * @returns {string}
 */
export function trimRedundantSuffix(suffix, prefix, period) {
  if (!suffix) return '';

  // Build set of lower-cased word tokens to strip
  const redundant = new Set();

  if (period) {
    for (const w of period.toLowerCase().split(/\s+/)) {
      redundant.add(w);
      // Also add 3-char abbreviation for full month names (e.g. "january" → "jan")
      if (MONTH_WORDS.has(w) && w.length > 3) redundant.add(w.slice(0, 3));
    }
  }

  if (prefix) {
    for (const w of prefix.toLowerCase().split(/[\s\-]+/).filter(Boolean)) {
      redundant.add(w);
      // Decompose fused digit-letter tokens so both parts are caught
      // e.g. "2550m" → add "2550" and "m" separately
      const sub = w.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/);
      if (sub.length > 1) sub.forEach((p) => redundant.add(p));
    }
  }

  const isBirPrefix = prefix != null && /^BIR\b/i.test(prefix);

  const kept = suffix.split(/\s+/).filter((w) => {
    const lower = w.toLowerCase();
    if (redundant.has(lower)) return false;
    if (/^20\d{2}$/.test(w)) return false;        // bare year
    if (MONTH_WORDS.has(lower)) return false;      // bare month name
    if (/^Q[1-4]$/i.test(w)) return false;        // quarter label
    // For BIR prefixes, also strip 4-digit form numbers with optional 1-2 letter suffix
    // (catches "0619E", "2550Q", "1702RT" that weren't matched via the redundant set)
    if (isBirPrefix && /^\d{4}[A-Za-z]{0,2}$/.test(w)) return false;
    return true;
  });

  return kept.join(' ');
}

/**
 * Build the canonical document name for a synced Tax PH attachment.
 *
 * Resolution order:
 *  1. Look up bucket in BUCKET_FORM_CODES; call fn(parsed) to get form code.
 *  2. If fn returns null, or bucket has no entry → use bucket label as prefix.
 *  3. If no bucket at all → omit the prefix segment entirely.
 *  4. Strip suffix words that duplicate the prefix or period.
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
  const rawSuffix = cleanFileSuffix(attachmentName);
  const suffix = trimRedundantSuffix(rawSuffix, prefix, period);

  const parts = [];
  if (prefix) parts.push(prefix);
  if (period) parts.push(period);
  if (suffix) parts.push(suffix);
  return parts.join(' - ');
}
