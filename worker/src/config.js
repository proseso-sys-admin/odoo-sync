/**
 * Config from env (Cloud Run / Secret Manager injects these).
 * Loads .env from worker root so it works regardless of process cwd.
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

function getEnv(name, def = '') {
  const v = process.env[name];
  return v !== undefined && v !== '' ? String(v).trim() : def;
}

export function getSourceConfig() {
  const baseUrl = getEnv('SOURCE_BASE_URL');
  const db = getEnv('SOURCE_DB');
  const login = getEnv('SOURCE_LOGIN');
  const password = getEnv('SOURCE_PASSWORD');
  if (!baseUrl || !db || !login || !password) {
    throw new Error('Missing SOURCE_* env: SOURCE_BASE_URL, SOURCE_DB, SOURCE_LOGIN, SOURCE_PASSWORD');
  }
  if (process.env.ODOO_SYNC_DEBUG) {
    console.error('[config] .env path:', envPath);
    console.error('[config] SOURCE_BASE_URL:', baseUrl);
    console.error('[config] SOURCE_DB:', db);
  }
  return { baseUrl, db, login, password };
}

export const ATTACHMENT_BATCH_LIMIT = Math.max(1, parseInt(getEnv('ATTACHMENT_BATCH_LIMIT', '200'), 10) || 200);
export const MAX_CONCURRENT_TARGETS = Math.max(1, parseInt(getEnv('MAX_CONCURRENT_TARGETS', '5'), 10) || 5);

/** Cloud Storage: bucket name (no gs://) and object path for state JSON */
export const STATE_GCS_BUCKET = getEnv('STATE_GCS_BUCKET', '');
export const STATE_GCS_PATH = getEnv('STATE_GCS_PATH', 'odoosync/state.json');
