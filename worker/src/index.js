/**
 * HTTP entrypoint for Cloud Run. Runs full sync and returns 200.
 * Set PORT (default 8080) for the server.
 */

import http from 'http';
import { runFullSync } from './runSync.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

async function handleSync(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const result = await runFullSync();
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error('Sync error', e);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/sync' || req.url === '/' || req.url === '') {
    if (req.method === 'POST' || req.method === 'GET') return handleSync(req, res);
  }
  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Odoo sync worker listening on port ${PORT}`);
});
