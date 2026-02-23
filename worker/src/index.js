/**
 * HTTP entrypoint for Cloud Run. Runs full sync and returns 200.
 * /sync and / accept optional query params for single-target: target_base_url, target_db, target_login, target_company_id.
 * POST /webhook accepts JSON body with optional target_key or target_base_url, target_db, target_login, target_company_id.
 * Set PORT (default 8080) for the server.
 */

import http from 'http';
import { runFullSync, runSingleAttachmentSync, runDeleteAttachmentSync } from './runSync.js';
import { targetKey } from './odoo.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

/** Parse URL and return searchParams (empty if invalid). */
function getSearchParams(url) {
  try {
    const u = new URL(url || '', 'http://localhost');
    return u.searchParams;
  } catch {
    return null;
  }
}

/** Build target key from query params if all four are present; otherwise null. */
function targetKeyFromQuery(searchParams) {
  if (!searchParams) return null;
  const baseUrl = searchParams.get('target_base_url')?.trim();
  const db = searchParams.get('target_db')?.trim();
  const login = searchParams.get('target_login')?.trim();
  const companyId = searchParams.get('target_company_id')?.trim();
  if (!baseUrl || !db || !login || companyId === undefined || companyId === '') return null;
  return targetKey(
    { baseUrl, db, login },
    parseInt(companyId, 10) || 1
  );
}

async function handleSync(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const searchParams = getSearchParams(req.url);
    const targetKeyParam = searchParams ? targetKeyFromQuery(searchParams) : null;
    const opts = targetKeyParam ? { targetKey: targetKeyParam } : {};
    const result = await runFullSync(opts);
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error('Sync error', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
}

/** Read JSON body from request. Resolves {} on empty or invalid JSON. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw || !raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch (e) {
        console.warn('[webhook] Invalid JSON body, treating as {}:', e?.message || e);
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

async function handleWebhook(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (secret) {
    const provided = req.headers['x-webhook-secret']?.trim();
    if (provided !== secret) {
      console.warn('[webhook] 401 Invalid or missing X-Webhook-Secret');
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'Invalid or missing webhook secret' }));
      return;
    }
  }
  try {
    const body = await readJsonBody(req);
    if (process.env.NODE_ENV !== 'production') {
      console.log('[webhook] POST body keys:', Object.keys(body));
    }

    // Single-attachment mode: sync or delete one specific file immediately
    if (body.attachment_id != null) {
      const action = String(body.action || 'sync').toLowerCase();
      console.log('[webhook] single-attachment', action, 'for attachment_id:', body.attachment_id);
      const result = action === 'unlink' || action === 'delete'
        ? await runDeleteAttachmentSync(body.attachment_id)
        : await runSingleAttachmentSync(body.attachment_id);
      res.statusCode = 200;
      res.end(JSON.stringify(result));
      return;
    }

    let targetKeyParam = body.target_key != null ? String(body.target_key).trim() : '';
    if (!targetKeyParam && body.target_base_url != null && body.target_db != null && body.target_login != null && body.target_company_id != null) {
      targetKeyParam = targetKey(
        {
          baseUrl: String(body.target_base_url).trim(),
          db: String(body.target_db).trim(),
          login: String(body.target_login).trim(),
        },
        parseInt(String(body.target_company_id), 10) || 1
      );
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[webhook] target:', targetKeyParam ? 'targetKey=' + targetKeyParam : 'full sync');
    }
    const opts = targetKeyParam ? { targetKey: targetKeyParam } : {};
    const result = await runFullSync(opts);
    if (opts.targetKey && result.target_filter === 'no_matching_route') {
      console.warn('[webhook] target_key did not match any route. Check baseUrl (trailing slash is normalized), db, login, company_id:', targetKeyParam);
    }
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error('Webhook error', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url?.split('?')[0] || '';
  if (urlPath === '/webhook' && req.method === 'POST') {
    return handleWebhook(req, res);
  }
  if (urlPath === '/sync' || urlPath === '/' || urlPath === '') {
    if (req.method === 'POST' || req.method === 'GET') return handleSync(req, res);
  }
  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Odoo sync worker listening on port ${PORT}`);
});
