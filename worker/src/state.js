/**
 * Sync state: main cursor (last_attachment_id) and per-target GC cursors.
 * Backend: Google Cloud Storage when STATE_GCS_BUCKET is set; otherwise in-memory (for local debug).
 */

import { Storage } from '@google-cloud/storage';
import { STATE_GCS_BUCKET, STATE_GCS_PATH } from './config.js';

const CURSOR_ID_KEY = 'ODOO_SYNC_LAST_ATTACHMENT_ID';
const LAST_FULL_RESCAN_KEY = 'ODOO_SYNC_LAST_TAX_FULL_RESCAN';
const GC_CURSOR_PREFIX = 'ODOO_SYNC_GC_LAST_TARGET_ATT_ID|';

let storage = null;
/** In-memory state when not using GCS or when GCS auth fails (local debug). */
let memoryState = {};
let gcsFailed = false;

function getStorage() {
  if (!storage) {
    if (!STATE_GCS_BUCKET || !STATE_GCS_PATH) {
      throw new Error('STATE_GCS_BUCKET and STATE_GCS_PATH must be set for sync state (e.g. gs://your-bucket/odoosync/state.json)');
    }
    storage = new Storage();
  }
  return storage;
}

function useGcs() {
  return Boolean(STATE_GCS_BUCKET && STATE_GCS_PATH) && !gcsFailed;
}

function getFile() {
  return getStorage().bucket(STATE_GCS_BUCKET).file(STATE_GCS_PATH);
}

async function readState() {
  if (!STATE_GCS_BUCKET || !STATE_GCS_PATH) return { ...memoryState };
  if (gcsFailed) return { ...memoryState };
  try {
    const [buf] = await getFile().download();
    if (!buf || !buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e.code === 404) return {};
    // 401/403 when running locally without GCP credentials: use in-memory state
    if (e.code === 401 || e.code === 403) {
      gcsFailed = true;
      console.warn('[state] GCS auth failed (', e.code, '), using in-memory state for this run. Leave STATE_GCS_BUCKET empty in .env for local debug.');
      return { ...memoryState };
    }
    throw e;
  }
}

async function writeState(state) {
  if (!useGcs()) {
    memoryState = { ...state };
    return;
  }
  await getFile().save(JSON.stringify(state, null, 2), { contentType: 'application/json' });
}

/**
 * Returns last attachment id for tax sync. May return 0 when:
 * - ODOO_SYNC_RESET_TAX_CURSOR=1|true (one-time manual reset), or
 * - ODOO_SYNC_TAX_RESCAN_DAYS=N is set and N days have passed since last full rescan (catches re-uploads that reuse the same attachment id).
 */
export async function getLastAttachmentId() {
  const reset = process.env.ODOO_SYNC_RESET_TAX_CURSOR;
  if (reset === '1' || reset === 'true') return 0;

  const state = await readState();
  const rescanDays = parseInt(process.env.ODOO_SYNC_TAX_RESCAN_DAYS || '0', 10);
  if (rescanDays > 0) {
    const lastRescan = state[LAST_FULL_RESCAN_KEY];
    const lastDate = lastRescan ? new Date(lastRescan) : null;
    const now = new Date();
    const daysSince = lastDate ? (now - lastDate) / (24 * 60 * 60 * 1000) : Infinity;
    if (daysSince >= rescanDays) {
      state[LAST_FULL_RESCAN_KEY] = now.toISOString();
      await writeState(state);
      return 0;
    }
  }

  return Math.max(0, parseInt(state[CURSOR_ID_KEY] || '0', 10));
}

export async function setLastAttachmentId(id) {
  const state = await readState();
  state[CURSOR_ID_KEY] = String(id);
  await writeState(state);
}

export async function getGcCursor(targetKey) {
  const state = await readState();
  const k = GC_CURSOR_PREFIX + targetKey;
  return Math.max(0, parseInt(state[k] || '0', 10));
}

export async function setGcCursor(targetKey, lastTargetAttId) {
  const state = await readState();
  state[GC_CURSOR_PREFIX + targetKey] = String(lastTargetAttId);
  await writeState(state);
}
