/**
 * Odoo JSON-RPC client and helpers (ported from Apps Script).
 */

const uidCache = new Map();

function cacheKey(cfg) {
  // Include password so different API keys for the same login don't share a cached uid
  // (otherwise one project's valid key would make another project's bad key appear to work).
  return `${cfg.baseUrl}|${cfg.db}|${cfg.login}|${cfg.password || ''}`;
}

export async function odooAuthenticate(cfg) {
  const key = cacheKey(cfg);
  if (uidCache.has(key)) return uidCache.get(key);
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/jsonrpc';
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: { service: 'common', method: 'authenticate', args: [cfg.db, cfg.login, cfg.password, {}] },
    id: 1,
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!text.trimStart().startsWith('{')) {
    throw new Error(
      `Odoo returned HTML instead of JSON (status ${res.status}). ` +
      `Check SOURCE_BASE_URL: use root URL only, e.g. https://your-db.odoo.com (no /web or /web/login). ` +
      `Got: ${text.slice(0, 80).replace(/\s+/g, ' ')}...`
    );
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Odoo auth error: ${JSON.stringify(data.error)}`);
  let uid = data.result;
  // Odoo.com (SaaS): sometimes db must be the subdomain; try deriving from URL if auth failed
  if (!uid && cfg.db && /\.odoo\.com/i.test(cfg.baseUrl || '')) {
    const sub = (cfg.baseUrl || '').match(/^https?:\/\/([a-z0-9-]+)\.odoo\.com/i);
    const dbFromUrl = sub ? sub[1] : '';
    if (dbFromUrl && dbFromUrl !== cfg.db) {
      const altPayload = {
        jsonrpc: '2.0',
        method: 'call',
        params: { service: 'common', method: 'authenticate', args: [dbFromUrl, cfg.login, cfg.password, {}] },
        id: 1,
      };
      const res2 = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(altPayload),
      });
      const data2 = await res2.json();
      if (data2.result) uid = data2.result;
    }
  }
  // Try empty db (some Odoo.com setups expect '' as database name)
  if (!uid && cfg.db) {
    const altPayload = {
      jsonrpc: '2.0',
      method: 'call',
      params: { service: 'common', method: 'authenticate', args: ['', cfg.login, cfg.password, {}] },
      id: 1,
    };
    const res2 = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(altPayload),
    });
    const data2 = await res2.json();
    if (data2.result) uid = data2.result;
  }
  if (!uid) {
    throw new Error(
      `Odoo auth failed (result false). ` +
      `If 2FA is enabled on your account, it is NOT supported for JSON-RPC — use an API key as SOURCE_PASSWORD instead (Settings → Users → your user → Account → API Keys). ` +
      `Otherwise check SOURCE_LOGIN and SOURCE_PASSWORD. Response: ${JSON.stringify(data)}`
    );
  }
  uidCache.set(key, uid);
  return uid;
}

export async function odooExecuteKw(cfg, model, method, args = [], kwargs = {}) {
  const uid = await odooAuthenticate(cfg);
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/jsonrpc';
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [cfg.db, uid, cfg.password, model, method, args, kwargs],
    },
    id: 2,
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!text.trimStart().startsWith('{')) {
    throw new Error(
      `Odoo returned HTML instead of JSON (status ${res.status}). ` +
      `Check SOURCE_BASE_URL: use root URL only, e.g. https://your-db.odoo.com (no /web or /web/login). ` +
      `Got: ${text.slice(0, 80).replace(/\s+/g, ' ')}...`
    );
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Odoo execute_kw ${model}.${method}: ${JSON.stringify(data.error)}`);
  return data.result;
}

// --- Parsing / helpers (ported from Apps Script) ---

export function isFalsyOdooValue(v) {
  if (v === null || v === undefined || v === false) return true;
  const s = String(v).trim().toLowerCase();
  return s === '' || s === 'false' || s === '0' || s === 'null' || s === 'none' || s === 'undefined';
}

export function normalizeOdooBaseUrl(raw) {
  if (isFalsyOdooValue(raw)) return '';
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s) && /^[a-z0-9-]+$/i.test(s)) {
    if (s.toLowerCase() === 'false') return '';
    s = `https://${s}.odoo.com/`;
  }
  s = s.replace(/^http:\/\//i, 'https://');
  s = s.replace(/(\.odoo\.com)\/odoo\/?$/i, '$1/');
  if (!s.endsWith('/')) s += '/';
  if (/^https:\/\/false\.odoo\.com\/$/i.test(s)) return '';
  return s;
}

export function deriveDbFromBaseUrl(baseUrl) {
  if (isFalsyOdooValue(baseUrl)) return '';
  const s = String(baseUrl || '').trim();
  const m = s.match(/^https:\/\/([a-z0-9-]+)\.odoo\.com\b/i);
  if (!m) return '';
  const db = (m[1] || '').trim();
  if (!db || db.toLowerCase() === 'false') return '';
  return db;
}

/** Parse x_studio_accounting_database into { target_base_url, target_db } */
export function parseAcctDb(raw) {
  if (isFalsyOdooValue(raw)) return { target_base_url: '', target_db: '' };
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { target_base_url: '', target_db: '' };
  if (s.startsWith('{') && s.endsWith('}')) {
    try {
      const o = JSON.parse(s);
      const bu = normalizeOdooBaseUrl(o.baseUrl || o.target_base_url || '');
      const db = bu ? deriveDbFromBaseUrl(bu) : String(o.db || o.target_db || '').trim();
      const bu2 = bu || normalizeOdooBaseUrl(db);
      return { target_base_url: bu2, target_db: deriveDbFromBaseUrl(bu2) };
    } catch (_) {
      return { target_base_url: '', target_db: '' };
    }
  }
  if (/^https?:\/\//i.test(s)) {
    const bu = normalizeOdooBaseUrl(s);
    return { target_base_url: bu, target_db: deriveDbFromBaseUrl(bu) };
  }
  const bu = normalizeOdooBaseUrl(s);
  return { target_base_url: bu, target_db: deriveDbFromBaseUrl(bu) };
}

export function m2oId(v) {
  if (v === null || v === undefined || v === '' || v === false) return false;
  if (Array.isArray(v)) return v.length ? m2oId(v[0]) : false;
  if (typeof v === 'object' && v !== null && 'id' in v) return m2oId(v.id);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : false;
}

export function requireId(v, ctx = {}) {
  const id = m2oId(v);
  if (!id) throw new Error('Invalid ID: ' + JSON.stringify({ got: v, ctx }));
  return id;
}

const MONTH_NAMES = {
  '01': 'January', '02': 'February', '03': 'March', '04': 'April', '05': 'May', '06': 'June',
  '07': 'July', '08': 'August', '09': 'September', '10': 'October', '11': 'November', '12': 'December',
};

/** Parse task name for Tax PH: year, monthName from [YYYY.MM] or [YYYY] */
export function parseTaxAndPeriodFromTaskName(taskName) {
  const raw = String(taskName || '').trim();
  const bracket = raw.match(/\[([^\]]+)\]/);
  const bracketVal = bracket ? String(bracket[1]).trim() : '';
  const monthNameFromMM = (mm) => MONTH_NAMES[String(mm).padStart(2, '0')] || String(mm);

  // Check for [YYYY.MM]
  let m = bracketVal.match(/\b(20\d{2})\.(0[1-9]|1[0-2])\b/);
  if (m) return { year: m[1], monthName: monthNameFromMM(m[2]) };

  // Check for [YYYY]
  m = bracketVal.match(/\b(20\d{2})\b/);
  if (m) {
    // If we only have year, look for Q1, Q2, Q3, Q4 in the task name
    const qMatch = raw.match(/\b(Q[1-4])\b/i);
    if (qMatch) {
      return { year: m[1], monthName: qMatch[1].toUpperCase() };
    }
    return { year: m[1], monthName: null };
  }
  return { year: null, monthName: null };
}

export function isQualifyingTaxTaskName(taskName) {
  return /Tax PH/i.test(taskName || '') && /\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]/.test(taskName || '');
}

/** Gvt contribs Filing: task name must contain "Gvt contribs Filing" and bracket period [YYYY] or [YYYY.MM]. */
export function isQualifyingGvtContribsTaskName(taskName) {
  return /Gvt contribs Filing/i.test(taskName || '') && /\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]/.test(taskName || '');
}

/** Build target key for GC cursor. Normalizes baseUrl so webhook payload matches route key. */
export function targetKey(targetCfg, companyId) {
  const baseUrl = normalizeOdooBaseUrl(targetCfg.baseUrl) || String(targetCfg.baseUrl || '').trim();
  return [baseUrl, targetCfg.db, targetCfg.login, String(companyId)].join('|');
}

/** Build target key from a route object (target_base_url, target_db, target_login, target_company_id). */
export function routeKey(route) {
  if (!route) return '';
  return targetKey(
    { baseUrl: route.target_base_url || '', db: route.target_db || '', login: route.target_login || '' },
    route.target_company_id ?? 1
  );
}

/** Idempotency marker for synced attachments */
export function buildMarker(sourceDb, sourceAttId) {
  return `ODOO_SYNC|SRC_DB=${sourceDb}|SRC_ATT=${sourceAttId}`;
}

export function parseSrcAttIdFromMarker(desc) {
  const m = String(desc || '').match(/ODOO_SYNC\|SRC_DB=[^|]+\|SRC_ATT=(\d+)/);
  return m ? Number(m[1]) : null;
}
