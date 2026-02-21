/**
 * Config from env (Cloud Run / Secret Manager injects these).
 * Loads .env from cwd when running locally.
 */
import 'dotenv/config';

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
  return { baseUrl, db, login, password };
}

export const ATTACHMENT_BATCH_LIMIT = Math.max(1, parseInt(getEnv('ATTACHMENT_BATCH_LIMIT', '200'), 10) || 200);
export const MAX_CONCURRENT_TARGETS = Math.max(1, parseInt(getEnv('MAX_CONCURRENT_TARGETS', '10'), 10) || 10);

/** Cloud Storage: bucket name (no gs://) and object path for state JSON */
export const STATE_GCS_BUCKET = getEnv('STATE_GCS_BUCKET', '');
export const STATE_GCS_PATH = getEnv('STATE_GCS_PATH', 'odoosync/state.json');
